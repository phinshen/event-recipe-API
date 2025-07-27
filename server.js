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
  const token = req.headers.authorization?.split("Bearer ")[1];
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.userId = decoded.uid;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
}

// GET all events for the authenticated user WITH recipes
app.get("/events", authenticateUser, async (req, res) => {
  try {
    console.log("Fetching events for user:", req.userId);

    // Get events with their recipes in one query
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
      WHERE e.user_id = $1
      GROUP BY e.id, e.name, e.date, e.image_url, e.user_id
      ORDER BY e.date DESC
    `,
      [req.userId]
    );

    // Format for frontend compatibility
    const eventsWithRecipes = result.rows.map((event) => ({
      id: event.id,
      title: event.name, // Map name to title for frontend compatibility
      name: event.name,
      date: event.date,
      image_url: event.image_url,
      recipes: event.recipes || [],
      created_at: event.date,
    }));

    res.json(eventsWithRecipes);
    console.log("Events fetched successfully");
  } catch (error) {
    console.error("Error fetching events:", error.message, error.stack);
    res.status(500).json({ error: error.message });
  }
});

// POST create event
app.post("/events", authenticateUser, async (req, res) => {
  const { name, date, description, location } = req.body;

  try {
    const result = await pool.query(
      "INSERT INTO events (user_id, name, date, image_url) VALUES ($1, $2, $3, $4) RETURNING *",
      [req.userId, name, date, ""] // Using empty string for image_url
    );

    const newEvent = result.rows[0];

    // Return in format expected by frontend
    res.json({
      id: newEvent.id,
      title: newEvent.name,
      name: newEvent.name,
      date: newEvent.date,
      image_url: newEvent.image_url,
      recipes: [],
      created_at: newEvent.date,
    });
    console.log("Event created successfully");
  } catch (error) {
    console.error("Error creating event:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// PUT update event
app.put("/events/:id", authenticateUser, async (req, res) => {
  const { name, date, description, location } = req.body;
  const { id } = req.params;

  try {
    const result = await pool.query(
      "UPDATE events SET name = $1, date = $2 WHERE id = $3 AND user_id = $4 RETURNING *",
      [name, date, id, req.userId]
    );

    const updatedEvent = result.rows[0];
    res.json({
      id: updatedEvent.id,
      title: updatedEvent.name,
      name: updatedEvent.name,
      date: updatedEvent.date,
      image_url: updatedEvent.image_url,
    });
    console.log("Event updated successfully");
  } catch (error) {
    console.error("Error updating event:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// DELETE event
app.delete("/events/:id", authenticateUser, async (req, res) => {
  const { id } = req.params;

  try {
    // Recipes will be deleted automatically due to CASCADE
    await pool.query("DELETE FROM events WHERE id = $1 AND user_id = $2", [
      id,
      req.userId,
    ]);
    res.json({ message: "Event deleted" });
    console.log("Event deleted successfully");
  } catch (error) {
    console.error("Error deleting event:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Add TheMealDB recipe to event
app.post("/events/:id/recipes", authenticateUser, async (req, res) => {
  const { id } = req.params;
  const { recipe } = req.body; // Full recipe object from TheMealDB

  try {
    // Check if recipe already exists for this event
    const existing = await pool.query(
      "SELECT id FROM recipes WHERE event_id = $1 AND meal_id = $2",
      [id, recipe.idMeal]
    );

    if (existing.rows.length > 0) {
      return res
        .status(409)
        .json({ error: "Recipe already added to this event" });
    }

    // Insert recipe
    await pool.query(
      "INSERT INTO recipes (event_id, meal_id, title, image) VALUES ($1, $2, $3, $4)",
      [id, recipe.idMeal, recipe.strMeal, recipe.strMealThumb]
    );

    // Return updated event with recipes
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

    const updatedEvent = result.rows[0];
    res.json({
      id: updatedEvent.id,
      title: updatedEvent.name,
      name: updatedEvent.name,
      date: updatedEvent.date,
      image_url: updatedEvent.image_url,
      recipes: updatedEvent.recipes || [],
      created_at: updatedEvent.date,
    });

    console.log("Recipe successfully added to event");
  } catch (error) {
    console.error("Error adding recipe to event:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Remove recipe from event
app.delete(
  "/events/:id/recipes/:mealId",
  authenticateUser,
  async (req, res) => {
    const { id, mealId } = req.params;

    try {
      await pool.query(
        "DELETE FROM recipes WHERE event_id = $1 AND meal_id = $2",
        [id, mealId]
      );

      // Return updated event with recipes
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

      const updatedEvent = result.rows[0];
      res.json({
        id: updatedEvent.id,
        title: updatedEvent.name,
        name: updatedEvent.name,
        date: updatedEvent.date,
        image_url: updatedEvent.image_url,
        recipes: updatedEvent.recipes || [],
        created_at: updatedEvent.date,
      });

      console.log("Recipe successfully removed from event");
    } catch (error) {
      console.error("Error removing recipe from event:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

// Test route
app.get("/", (req, res) => {
  res.send("Welcome to the Event Recipe API!");
});

// Only run this locally!
if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running locally on port ${PORT}`);
  });
}

export default app;
