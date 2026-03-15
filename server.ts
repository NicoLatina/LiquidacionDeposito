import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import multer from "multer";
import fs from "fs";
import { Storage } from "@google-cloud/storage";

// --- Configuration ---
const DATA_DIR = "/tmp/data";
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const DATA_FILE = path.join(DATA_DIR, "products.json");
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
const BUCKET_NAME = process.env.GCS_BUCKET_NAME || (PROJECT_ID ? `${PROJECT_ID}.appspot.com` : null);

// Ensure local directories exist
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// --- Storage Abstraction ---
interface StorageBackend {
  type: 'gcs' | 'local';
  getProducts(): Promise<any[]>;
  saveProducts(products: any[]): Promise<void>;
  uploadFile(file: Express.Multer.File): Promise<string>; // Returns public URL
  deleteProduct(id: string): Promise<void>;
  updateProduct(id: string, updates: any): Promise<any>;
}

class LocalStorage implements StorageBackend {
  type: 'local' = 'local';

  async getProducts() {
    try {
      if (!fs.existsSync(DATA_FILE)) return [];
      const content = fs.readFileSync(DATA_FILE, "utf-8");
      return JSON.parse(content);
    } catch (error) {
      console.error("Local read error:", error);
      return [];
    }
  }

  async saveProducts(products: any[]) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(products, null, 2));
  }

  async uploadFile(file: Express.Multer.File) {
    // Move from memory/temp to uploads dir
    const filename = `${Date.now()}-${file.originalname}`;
    const filepath = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(filepath, file.buffer);
    return `/uploads/${filename}`;
  }

  async deleteProduct(id: string) {
    // Local deletion logic if needed (e.g. delete image)
    // For now, just metadata is handled in saveProducts
  }

  async updateProduct(id: string, updates: any) {
    const products = await this.getProducts();
    const index = products.findIndex((p: any) => p.id === id);
    if (index !== -1) {
      products[index] = { ...products[index], ...updates };
      await this.saveProducts(products);
      return products[index];
    }
    throw new Error("Product not found");
  }
}

class GoogleCloudStorage implements StorageBackend {
  type: 'gcs' = 'gcs';
  private bucket: any;
  private dataFile: any;

  constructor(bucketName: string) {
    const storage = new Storage();
    this.bucket = storage.bucket(bucketName);
    this.dataFile = this.bucket.file("products.json");
  }

  async getProducts() {
    const [exists] = await this.dataFile.exists();
    if (!exists) return [];
    const [content] = await this.dataFile.download();
    return JSON.parse(content.toString());
  }

  async saveProducts(products: any[]) {
    await this.dataFile.save(JSON.stringify(products, null, 2));
  }

  async uploadFile(file: Express.Multer.File) {
    const filename = `images/${Date.now()}-${file.originalname}`;
    const blob = this.bucket.file(filename);
    
    await blob.save(file.buffer, {
      contentType: file.mimetype,
      resumable: false
    });

    // Assuming public bucket or uniform bucket-level access
    return `https://storage.googleapis.com/${this.bucket.name}/${filename}`;
  }

  async deleteProduct(id: string) {
    // GCS deletion logic
  }

  async updateProduct(id: string, updates: any) {
    const products = await this.getProducts();
    const index = products.findIndex((p: any) => p.id === id);
    if (index !== -1) {
      products[index] = { ...products[index], ...updates };
      await this.saveProducts(products);
      return products[index];
    }
    throw new Error("Product not found");
  }
}

// --- Server Setup ---
const upload = multer({ storage: multer.memoryStorage() });

async function startServer() {
  const app = express();
  const PORT = process.env.K_SERVICE ? parseInt(process.env.PORT as string) || 8080 : 3000;

  app.use(express.json());
  app.use("/uploads", express.static(UPLOADS_DIR));

  // Initialize Storage
  let storage: StorageBackend = new LocalStorage();
  let storageError: string | null = null;

  if (BUCKET_NAME) {
    try {
      console.log(`Attempting to connect to GCS Bucket: ${BUCKET_NAME}`);
      const gcs = new GoogleCloudStorage(BUCKET_NAME);
      // Test connection
      await gcs.getProducts(); 
      storage = gcs;
      console.log("Successfully connected to Google Cloud Storage");
    } catch (error: any) {
      console.error("GCS Connection Failed:", error.message);
      storageError = error.message;
      console.log("Falling back to Local Storage (Ephemeral)");
    }
  } else {
    storageError = "No Project ID or Bucket Name found";
    console.log("No GCS config found. Using Local Storage.");
  }

  // API Routes
  app.get("/api/status", (req, res) => {
    res.json({
      storageType: storage.type,
      projectId: PROJECT_ID,
      bucketName: BUCKET_NAME,
      error: storageError
    });
  });

  app.get("/api/products", async (req, res) => {
    const products = await storage.getProducts();
    res.json(products);
  });

  app.post("/api/products", upload.single("image"), async (req, res) => {
    try {
      const { description, price } = req.body;
      const file = req.file;

      if (!file || !description) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const publicUrl = await storage.uploadFile(file);
      const products = await storage.getProducts();
      
      const newProduct = {
        id: Date.now().toString(),
        description,
        price: price ? parseFloat(price) : null,
        image_url: publicUrl,
        created_at: new Date().toISOString(),
      };
      
      products.unshift(newProduct);
      await storage.saveProducts(products);

      res.status(201).json(newProduct);
    } catch (error: any) {
      console.error("Upload error:", error);
      res.status(500).json({ error: "Failed to create product", details: error.message });
    }
  });

  app.delete("/api/products/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const products = await storage.getProducts();
      const newProducts = products.filter((p: any) => p.id !== id);
      
      if (products.length === newProducts.length) {
        return res.status(404).json({ error: "Product not found" });
      }

      await storage.saveProducts(newProducts);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete product" });
    }
  });

  app.patch("/api/products/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body;
      const updatedProduct = await storage.updateProduct(id, updates);
      res.json(updatedProduct);
    } catch (error: any) {
      if (error.message === "Product not found") {
        return res.status(404).json({ error: "Product not found" });
      }
      res.status(500).json({ error: "Failed to update product" });
    }
  });

  // Vite middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
    app.get("*", (req, res) => {
      res.sendFile(path.join(process.cwd(), "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
