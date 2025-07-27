import dotenv from "dotenv";
dotenv.config();
import express from "express";
import cors from "cors";
import pg from "pg";
import admin from "firebase-admin";
import serviceAccount from "./firebaseServiceAccountKey.json" with { type: "json" };

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
  const token = req.headers.authorization?.split("Bearer ")[1]; // Extract token from Authorization header
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const decoded = await admin.auth().verifyIdToken(token); //verify token with Firebase
    req.userId = decoded.uid; // save user ID to request object
    next(); // proceed to next middleware/route
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
}

// GET all events for the authenticated user
app.get("/events", authenticateUser, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM events WHERE user_id = $1", [
      req.userId,
    ]);
    res.json(result.rows);
    console.log("Events fetched successfully");
  } catch (error) {
    console.error("Error fetching events:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

//POST create event
app.post("/events", authenticateUser, async (req, res) => {
  const { title, date } = req.body;

  try {
    const result = await pool.query(
      "INSERT INTO events (user_id, title, date) VALUES ($1, $2, $3) RETURNING *",
      [req.userId, title, date]
    );
    res.json(result.rows[0]);
    console.log("Events created successfully");
  } catch (error) {
    console.error("Error creating events:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// PUT update event
app.put("/events/:id", authenticateUser, async (req, res) => {
  const { title, date } = req.body;
  const { id } = req.params;

  try {
    const result = await pool.query(
      "UPDATE events SET title = $1, date = $2 WHERE id = $3 AND user_id = $4 RETURNING *",
      [title, date, id, req.userId]
    );
    res.json(result.rows[0]);
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

// Link a recipe to an event for the user
app.post("/events/:id/recipes", authenticateUser, async (req, res) => {
  const { id } = req.params;
  const { recipeId } = req.body;

  try {
    const result = await pool.query(
      "INSERT INTO event_recipes (event_id, recipe_id, user_id) VALUES ($1, $2, $3)",
      [id, recipeId, req.userId]
    );
    res.status(201).json(result);
    console.log("Recipe successfully added to event");
  } catch (error) {
    console.error("Error linking to event:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Unlink a recipe from an event for the user
app.delete(
  "/events/:id/recipes/:recipeId",
  authenticateUser,
  async (req, res) => {
    const { id, recipeId } = req.params;

    try {
      const result = await pool.query(
        "DELETE FROM event_recipes WHERE event_id = $1 AND recipe_id = $2 AND user_id = $3",
        [id, recipeId, req.userId]
      );
      res.status(201).json(result);
      console.log("Recipe successfully unlink from event");
    } catch (error) {
      console.error("Error unlink from event:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

// Get custom recipes for the authenticated user
app.get("/recipes", authenticateUser, async (req, res) => {
  const { custom } = req.query;

  try {
    const result = await pool.query(
      "SELECT * FROM recipes WHERE user_id = $1 AND custom = $2",
      [req.userId, custom === "true"]
    );
    res.status(200).json(result.rows);
    console.log("Recipe successfully fetched");
  } catch (error) {
    console.error("Error fetching recipe:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Create a new custom recipe for the user
app.post("/recipes", authenticateUser, async (req, res) => {
  const { title, ingredients, instructions } = req.body;

  try {
    const result = await pool.query(
      "INSERT INTO recipes (user_id, title, ingredients, instructions, custom) VALUES ($1, $2, $3, $4, true) RETURNING *",
      [req.userId, title, ingredients, instructions]
    );
    res.status(201).json(result.rows[0]);
    console.log("Recipe successfully created");
  } catch (error) {
    console.error("Error creating recipe:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Update an existing custom recipe for the user
app.put("/recipes/:id", authenticateUser, async (req, res) => {
  const { id } = req.params;
  const { title, ingredients, instructions } = req.body;

  try {
    const result = await pool.query(
      "UPDATE recipes SET title = $1, ingredients = $2, instructions = $3 WHERE id = $4 AND user_id = $5 RETURNING *",
      [title, ingredients, instructions, id, req.userId]
    );
    res.status(201).json(result.rows[0]);
    console.log("Recipe successfully updated");
  } catch (error) {
    console.error("Error updating recipe:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Delete a custom recipe for the user
app.delete("/recipes/:id", authenticateUser, async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query("DELETE FROM recipes WHERE id = $1 AND user_id = $2", [
      id,
      req.userId,
    ]);
    res.json({ message: "Recipe deleted" });
    console.log("Recipe successfully deleted");
  } catch (error) {
    console.error("Error deleting recipe:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Test route
app.get("/", (req, res) => {
  res.send("Welcome to the API!");
});

// Start the Express server
app.listen(3000, () => console.log("Server running on port 3000"));

export default app;
