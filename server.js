import dotenv from "dotenv";
dotenv.config();
import express from "express";
import cors from "cors";
import pg from "pg";
import admin from "firebase-admin";

const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
app.use(cors());
app.use(express.json());

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// middleware to authenticate Firebase user
async function authenticateUser(req, res, next) {
  try {
    const token = req.headers.authorization?.split("Bearer ")[1];
    console.log("🔐 Token received:", token ? "Yes" : "No");

    if (!token) {
      console.log("❌ No token provided");
      return res.status(401).json({ error: "Missing token" });
    }

    const decoded = await admin.auth().verifyIdToken(token);
    req.userId = decoded.uid;
    console.log("✅ User authenticated:", req.userId);
    next();
  } catch (err) {
    console.error("❌ Auth error:", err.message);
    res.status(401).json({ error: "Invalid token" });
  }
}

// Add TheMealDB recipe to event - WITH DEBUGGING
app.post("/events/:id/recipes", authenticateUser, async (req, res) => {
  const { id } = req.params;
  const { recipe } = req.body;

  console.log("🍳 Adding recipe to event:");
  console.log("Event ID:", id);
  console.log("User ID:", req.userId);
  console.log("Recipe data:", recipe);

  try {
    // Validate input data
    if (!recipe) {
      console.log("❌ No recipe data provided");
      return res.status(400).json({ error: "Recipe data is required" });
    }

    if (!recipe.idMeal || !recipe.strMeal) {
      console.log("❌ Invalid recipe data:", recipe);
      return res
        .status(400)
        .json({ error: "Recipe must have idMeal and strMeal" });
    }

    // Check if event exists and belongs to user
    console.log("🔍 Checking if event exists...");
    const eventCheck = await pool.query(
      "SELECT id FROM events WHERE id = $1 AND user_id = $2",
      [id, req.userId]
    );

    if (eventCheck.rows.length === 0) {
      console.log("❌ Event not found or doesn't belong to user");
      return res.status(404).json({ error: "Event not found" });
    }

    console.log("✅ Event found, checking for duplicate recipe...");

    // Check if recipe already exists for this event
    const existing = await pool.query(
      "SELECT id FROM recipes WHERE event_id = $1 AND meal_id = $2",
      [id, recipe.idMeal]
    );

    if (existing.rows.length > 0) {
      console.log("❌ Recipe already exists");
      return res
        .status(409)
        .json({ error: "Recipe already added to this event" });
    }

    console.log("✅ No duplicate found, inserting recipe...");

    // Insert recipe
    const insertResult = await pool.query(
      "INSERT INTO recipes (event_id, meal_id, title, image) VALUES ($1, $2, $3, $4) RETURNING *",
      [id, recipe.idMeal, recipe.strMeal, recipe.strMealThumb || ""]
    );

    console.log("✅ Recipe inserted:", insertResult.rows[0]);

    // Return updated event with recipes
    console.log("🔄 Fetching updated event data...");
    const result = await pool.query(
      `
      SELECT 
        e.id,
        e.name,
        e.date,
        e.image_url,
        e.user_id,
        COALESCE(
          json_agg(
            CASE WHEN r.id IS NOT NULL THEN
              json_build_object(
                'id', r.id,
                'idMeal', r.meal_id,
                'strMeal', r.title,
                'strMealThumb', r.image,
                'strCategory', 'Unknown',
                'strArea', 'Unknown'
              )
            END
          ) FILTER (WHERE r.id IS NOT NULL), 
          '[]'
        ) as recipes
      FROM events e
      LEFT JOIN recipes r ON e.id = r.event_id
      WHERE e.id = $1 AND e.user_id = $2
      GROUP BY e.id, e.name, e.date, e.image_url, e.user_id
    `,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      console.log("❌ Could not fetch updated event");
      return res.status(500).json({ error: "Could not fetch updated event" });
    }

    const updatedEvent = result.rows[0];
    console.log("✅ Updated event data:", updatedEvent);

    const responseData = {
      id: updatedEvent.id,
      title: updatedEvent.name,
      name: updatedEvent.name,
      date: updatedEvent.date,
      image_url: updatedEvent.image_url,
      recipes: updatedEvent.recipes || [],
      created_at: updatedEvent.date,
    };

    console.log("✅ Sending response:", responseData);
    res.json(responseData);
  } catch (error) {
    console.error("💥 Server error in add recipe:", error);
    console.error("Error stack:", error.stack);
    res.status(500).json({
      error: "Internal Server Error",
      details: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

// Test the database connection
app.get("/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({
      success: true,
      time: result.rows[0].now,
      message: "Database connection successful",
    });
  } catch (error) {
    console.error("Database test failed:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Test route
app.get("/", (req, res) => {
  res.json({
    message: "Welcome to the Event Recipe API!",
    timestamp: new Date().toISOString(),
    env: {
      nodeEnv: process.env.NODE_ENV,
      hasDbUrl: !!process.env.DATABASE_URL,
      hasFirebaseConfig: !!process.env.FIREBASE_CONFIG,
    },
  });
});

// ... (rest of your existing routes)

// Error handling middleware
app.use((error, req, res, next) => {
  console.error("💥 Unhandled error:", error);
  res.status(500).json({
    error: "Internal Server Error",
    message: error.message,
    stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
  });
});

// Only run this locally!
if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running locally on port ${PORT}`);
  });
}

export default app;
