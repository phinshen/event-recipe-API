import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

const app = express();
app.use(cors());
app.use(express.json());

// GET all events for a user
app.get("/events/:uid", async (req, res) => {
  const { uid } = req.params;

  try {
    const result = await pool.query("SELECT * FROM events WHERE user_id = $1", [
      uid,
    ]);
    res.json(result.rows);
    console.log("Events fetched successfully");
  } catch (error) {
    console.error("Error fetching events:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

//POST create event
app.post("/events", async (req, res) => {
  const { user_id, name, date, image_url } = req.body;

  try {
    const result = await pool.query(
      "INSERT INTO events (user_id, name, date, image_url) VALUES ($1, $2, $3, $4) RETURNING *",
      [user_id, name, date, image_url]
    );
    res.status(201).json(result.rows[0]);
    console.log("Event created successfully");
  } catch (error) {
    console.error("Error creating event:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// PUT update event
app.put("/events/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const { name, date, image_url } = req.body;
    const result = await pool.query(
      "UPDATE events SET name = $1, date = $2, image_url = $3 WHERE id = $4 RETURNING *",
      [name, date, image_url, id]
    );
    res.json(result.rows[0]);
    console.log("Event updated successfully");
  } catch (error) {
    console.error("Error updating event:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// DELETE event
app.delete("/events/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query("DELETE FROM events WHERE id = $1", [id]);
    res.status(204).send();
    console.log("Event deleted successfully");
  } catch (error) {
    console.error("Error deleting event:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Test route
app.get("/", (req, res) => {
  res.send("Welcome to the API!");
});

export default app;
