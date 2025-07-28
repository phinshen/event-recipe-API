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
    console.error("Authentication error:", err);
    res.status(401).json({ error: "Invalid token" });
  }
}

// GET all events for the authenticated user WITH recipes
app.get("/events", authenticateUser, async (req, res) => {
  try {
    console.log("Fetching events for user:", req.userId);

    // Get all events for the user
    const eventsResult = await pool.query(
      `SELECT id, name, date, image_url, description, location, created_at
       FROM events 
       WHERE user_id = $1 
       ORDER BY date DESC`,
      [req.userId]
    );

    console.log(`Found ${eventsResult.rows.length} events`);

    // Get recipes for all events in a single query
    const eventIds = eventsResult.rows.map((event) => event.id);
    let recipes = [];

    if (eventIds.length > 0) {
      const recipesResult = await pool.query(
        `SELECT event_id, id, meal_id, title, image, ingredients, instructions, custom, category, area, tags, youtube_url, source_url, recipe_data
         FROM recipes 
         WHERE event_id = ANY($1::int[])
         ORDER BY id DESC`,
        [eventIds]
      );
      recipes = recipesResult.rows;
    }

    // Group recipes by event_id
    const recipesByEvent = recipes.reduce((acc, recipe) => {
      if (!acc[recipe.event_id]) {
        acc[recipe.event_id] = [];
      }

      // Use the stored recipe_data to reconstruct the complete recipe
      const storedData = JSON.parse(recipe.recipe_data || "{}");

      acc[recipe.event_id].push({
        id: recipe.id,
        idMeal: recipe.meal_id,
        strMeal: recipe.title,
        strMealThumb: recipe.image,
        strCategory: storedData.strCategory || recipe.category || "Unknown",
        strArea: storedData.strArea || recipe.area || "Unknown",
        strTags: storedData.strTags || recipe.tags || "",
        strYoutube: storedData.strYoutube || recipe.youtube_url || "",
        strSource: storedData.strSource || recipe.source_url || "",
        strInstructions:
          recipe.instructions || storedData.strInstructions || "",
        custom: recipe.custom,
        // Include all the individual ingredient/measure properties
        ...Object.keys(storedData)
          .filter(
            (key) =>
              key.startsWith("strIngredient") || key.startsWith("strMeasure")
          )
          .reduce((acc, key) => {
            acc[key] = storedData[key];
            return acc;
          }, {}),
        // Keep concatenated ingredients for backward compatibility
        strIngredients: recipe.ingredients,
      });
      return acc;
    }, {});

    // Combine events with their recipes
    const eventsWithRecipes = eventsResult.rows.map((event) => ({
      id: event.id,
      title: event.name, // Map name to title for frontend compatibility
      name: event.name,
      date: event.date,
      description: event.description || "",
      location: event.location || "",
      image_url: event.image_url || "",
      recipes: recipesByEvent[event.id] || [],
      created_at: event.created_at,
    }));

    res.json(eventsWithRecipes);
    console.log("Events fetched successfully");
  } catch (error) {
    console.error("Error fetching events:", error.message, error.stack);
    res.status(500).json({
      error: "Failed to fetch events",
      details:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
});

// POST create event
app.post("/events", authenticateUser, async (req, res) => {
  const { name, date, description, location } = req.body;

  try {
    console.log("Creating event:", { name, date, description, location });

    if (!name || !date) {
      return res.status(400).json({ error: "Name and date are required" });
    }

    const result = await pool.query(
      `INSERT INTO events (user_id, name, date, description, location, image_url, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP) 
       RETURNING *`,
      [req.userId, name, date, description || "", location || "", ""]
    );

    const newEvent = result.rows[0];

    // Return in format expected by frontend
    res.status(201).json({
      id: newEvent.id,
      title: newEvent.name,
      name: newEvent.name,
      date: newEvent.date,
      description: newEvent.description || "",
      location: newEvent.location || "",
      image_url: newEvent.image_url || "",
      recipes: [],
      created_at: newEvent.created_at,
    });
    console.log("Event created successfully");
  } catch (error) {
    console.error("Error creating event:", error);
    res.status(500).json({
      error: "Failed to create event",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// PUT update event
app.put("/events/:id", authenticateUser, async (req, res) => {
  const { name, date, description, location } = req.body;
  const { id } = req.params;

  try {
    const result = await pool.query(
      `UPDATE events 
       SET name = $1, date = $2, description = $3, location = $4
       WHERE id = $5 AND user_id = $6 
       RETURNING *`,
      [name, date, description || "", location || "", id, req.userId]
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Event not found or access denied" });
    }

    const updatedEvent = result.rows[0];
    res.json({
      id: updatedEvent.id,
      title: updatedEvent.name,
      name: updatedEvent.name,
      date: updatedEvent.date,
      description: updatedEvent.description || "",
      location: updatedEvent.location || "",
      image_url: updatedEvent.image_url || "",
    });
    console.log("Event updated successfully");
  } catch (error) {
    console.error("Error updating event:", error);
    res.status(500).json({ error: "Failed to update event" });
  }
});

// DELETE event
app.delete("/events/:id", authenticateUser, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      "DELETE FROM events WHERE id = $1 AND user_id = $2 RETURNING id",
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Event not found or access denied" });
    }

    res.json({ message: "Event deleted" });
    console.log("Event deleted successfully");
  } catch (error) {
    console.error("Error deleting event:", error);
    res.status(500).json({ error: "Failed to delete event" });
  }
});

// Add TheMealDB recipe to event
app.post("/events/:id/recipes", authenticateUser, async (req, res) => {
  const { id } = req.params;
  const { recipe } = req.body;

  try {
    console.log("Adding recipe to event:", {
      eventId: id,
      recipeId: recipe?.idMeal,
      recipeName: recipe?.strMeal,
      userId: req.userId,
    });

    if (!recipe || !recipe.idMeal || !recipe.strMeal) {
      return res.status(400).json({ error: "Invalid recipe data." });
    }

    // Check if event belongs to user
    const eventCheck = await pool.query(
      "SELECT id FROM events WHERE id = $1 AND user_id = $2",
      [id, req.userId]
    );

    if (eventCheck.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Event not found or access denied" });
    }

    // Check if this recipe already exists for the event
    const existing = await pool.query(
      "SELECT id FROM recipes WHERE event_id = $1 AND meal_id = $2",
      [id, recipe.idMeal]
    );

    if (existing.rows.length > 0) {
      return res
        .status(409)
        .json({ error: "Recipe already added to this event" });
    }

    // Extract ingredients into readable format (keep this for backward compatibility)
    const ingredients = [];
    for (let i = 1; i <= 20; i++) {
      const ingredient = recipe[`strIngredient${i}`];
      const measure = recipe[`strMeasure${i}`];
      if (ingredient && ingredient.trim() !== "") {
        ingredients.push(`${measure?.trim()} ${ingredient.trim()}`.trim());
      }
    }
    const ingredientsText = ingredients.join(", ");

    const insertResult = await pool.query(
      `INSERT INTO recipes 
        (event_id, user_id, meal_id, title, image, ingredients, instructions, custom, category, area, tags, youtube_url, source_url, recipe_data)
       VALUES 
        ($1, $2, $3, $4, $5, $6, $7, false, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        id,
        req.userId,
        recipe.idMeal,
        recipe.strMeal,
        recipe.strMealThumb || "",
        ingredientsText,
        recipe.strInstructions || "",
        recipe.strCategory || "Unknown",
        recipe.strArea || "Unknown",
        recipe.strTags || null,
        recipe.strYoutube || null,
        recipe.strSource || null,
        recipe, // save entire object as JSONB - THIS IS KEY!
      ]
    );

    console.log("Recipe inserted successfully");

    // Return updated event with all recipes
    const updatedEvent = await getEventWithRecipes(id, req.userId);
    res.json(updatedEvent);
  } catch (error) {
    console.error("Error inserting recipe:", error);
    res.status(500).json({ error: "Failed to add recipe to event" });
  }
});

// helper function:
async function getEventWithRecipes(eventId, userId) {
  try {
    const eventResult = await pool.query(
      `SELECT id, name, date, image_url, description, location, created_at
       FROM events 
       WHERE id = $1 AND user_id = $2`,
      [eventId, userId]
    );

    if (eventResult.rows.length === 0) {
      throw new Error("Event not found");
    }

    const event = eventResult.rows[0];

    // Updated to include recipe_data
    const recipesResult = await pool.query(
      `SELECT id, meal_id, title, image, ingredients, instructions, custom, category, area, tags, youtube_url, source_url, recipe_data
       FROM recipes 
       WHERE event_id = $1 AND user_id = $2
       ORDER BY id DESC`,
      [eventId, userId]
    );

    const recipes = recipesResult.rows.map((recipe) => {
      // Use the stored recipe_data (JSONB) to reconstruct the full recipe object
      const storedData = recipe.recipe_data || {};

      // Create a complete recipe object that matches TheMealDB format
      const completeRecipe = {
        id: recipe.id,
        idMeal: recipe.meal_id,
        strMeal: recipe.title,
        strMealThumb: recipe.image,
        strCategory: storedData.strCategory || recipe.category || "Unknown",
        strArea: storedData.strArea || recipe.area || "Unknown",
        strTags: storedData.strTags || recipe.tags || "",
        strYoutube: storedData.strYoutube || recipe.youtube_url || "",
        strSource: storedData.strSource || recipe.source_url || "",
        strInstructions:
          recipe.instructions || storedData.strInstructions || "",
        custom: recipe.custom,
        // Include all the individual ingredient/measure properties from stored data
        ...Object.keys(storedData)
          .filter(
            (key) =>
              key.startsWith("strIngredient") || key.startsWith("strMeasure")
          )
          .reduce((acc, key) => {
            acc[key] = storedData[key];
            return acc;
          }, {}),
        // Also include the concatenated ingredients for backward compatibility
        strIngredients: recipe.ingredients,
      };

      return completeRecipe;
    });

    return {
      id: event.id,
      title: event.name,
      name: event.name,
      date: event.date,
      description: event.description || "",
      location: event.location || "",
      image_url: event.image_url || "",
      recipes: recipes,
      created_at: event.created_at,
    };
  } catch (error) {
    console.error("Error in getEventWithRecipes:", error);
    throw error;
  }
}

// Helper function to get event with recipes - ADD THIS HERE
async function getEventWithRecipes(eventId, userId) {
  try {
    const eventResult = await pool.query(
      `SELECT id, name, date, image_url, description, location, created_at
       FROM events 
       WHERE id = $1 AND user_id = $2`,
      [eventId, userId]
    );

    if (eventResult.rows.length === 0) {
      throw new Error("Event not found");
    }

    const event = eventResult.rows[0];

    // Updated to include user_id filter for extra security
    const recipesResult = await pool.query(
      `SELECT id, meal_id, title, image, ingredients, instructions, custom
       FROM recipes 
       WHERE event_id = $1 AND user_id = $2
       ORDER BY id DESC`,
      [eventId, userId] // Added userId parameter
    );

    const recipes = recipesResult.rows.map((recipe) => {
      const full = recipe.recipe_data || {};
      return {
        id: recipe.id,
        idMeal: recipe.meal_id,
        strMeal: recipe.title,
        strMealThumb: recipe.image,
        strCategory: recipe.category || full.strCategory || "Unknown",
        strArea: recipe.area || full.strArea || "Unknown",
        strTags: recipe.tags || full.strTags || "",
        strYoutube: recipe.youtube_url || full.strYoutube || "",
        strSource: recipe.source_url || full.strSource || "",
        strIngredients: recipe.ingredients,
        strInstructions: recipe.instructions,
        custom: recipe.custom,
      };
    });

    return {
      id: event.id,
      title: event.name,
      name: event.name,
      date: event.date,
      description: event.description || "",
      location: event.location || "",
      image_url: event.image_url || "",
      recipes: recipes,
      created_at: event.created_at,
    };
  } catch (error) {
    console.error("Error in getEventWithRecipes:", error);
    throw error;
  }
}

// Test route
app.get("/", (req, res) => {
  res.json({
    message: "Welcome to the Event Recipe API!",
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

// Health check
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "healthy", database: "connected" });
  } catch (error) {
    console.error("Database health check failed:", error);
    res.status(500).json({ status: "unhealthy", database: error.message });
  }
});

// Only run this locally!
if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running locally on port ${PORT}`);
  });
}

export default app;
