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

// CORS Configuration
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    const allowedOrigins = [
      "http://localhost:3000",
      "http://localhost:5173",
      "http://localhost:4173",
      "https://your-frontend-domain.vercel.app",
    ];

    if (
      origin.startsWith("http://localhost:") ||
      allowedOrigins.includes(origin)
    ) {
      return callback(null, true);
    }

    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Origin",
    "X-Requested-With",
    "Content-Type",
    "Accept",
    "Authorization",
    "Cache-Control",
    "Pragma",
  ],
  preflightContinue: false,
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
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

// FIXED: Safe helper function to reconstruct recipe data
function reconstructRecipeData(recipe) {
  try {
    // Start with basic recipe structure
    let completeRecipe = {
      id: recipe.id,
      idMeal: recipe.meal_id,
      strMeal: recipe.title,
      strMealThumb: recipe.image,
      strCategory: recipe.category || "Unknown",
      strArea: recipe.area || "Unknown",
      strTags: recipe.tags || "",
      strYoutube: recipe.youtube_url || "",
      strSource: recipe.source_url || "",
      strInstructions: recipe.instructions || "",
      strIngredients: recipe.ingredients,
      custom: recipe.custom,
    };

    // Safely try to parse and merge recipe_data
    if (recipe.recipe_data) {
      try {
        let storedData;

        // Handle both string and object cases
        if (typeof recipe.recipe_data === "string") {
          storedData = JSON.parse(recipe.recipe_data);
        } else {
          storedData = recipe.recipe_data;
        }

        // Only override with stored data if it exists and is not "Unknown"
        if (storedData.strCategory && storedData.strCategory !== "Unknown") {
          completeRecipe.strCategory = storedData.strCategory;
        }
        if (storedData.strArea && storedData.strArea !== "Unknown") {
          completeRecipe.strArea = storedData.strArea;
        }
        if (storedData.strTags) {
          completeRecipe.strTags = storedData.strTags;
        }
        if (storedData.strYoutube) {
          completeRecipe.strYoutube = storedData.strYoutube;
        }
        if (storedData.strSource) {
          completeRecipe.strSource = storedData.strSource;
        }
        if (storedData.strInstructions) {
          completeRecipe.strInstructions = storedData.strInstructions;
        }

        // Add individual ingredient/measure properties
        Object.keys(storedData)
          .filter(
            (key) =>
              key.startsWith("strIngredient") || key.startsWith("strMeasure")
          )
          .forEach((key) => {
            if (storedData[key]) {
              completeRecipe[key] = storedData[key];
            }
          });
      } catch (parseError) {
        // If JSON parsing fails, just use the basic structure
        console.warn(
          "Failed to parse recipe_data for recipe:",
          recipe.id,
          parseError.message
        );
      }
    }

    return completeRecipe;
  } catch (error) {
    console.error(
      "Error reconstructing recipe data for recipe:",
      recipe.id,
      error
    );
    // Return minimal safe structure if everything fails
    return {
      id: recipe.id,
      idMeal: recipe.meal_id,
      strMeal: recipe.title,
      strMealThumb: recipe.image,
      strCategory: "Unknown",
      strArea: "Unknown",
      strTags: "",
      strYoutube: "",
      strSource: "",
      strInstructions: recipe.instructions || "",
      strIngredients: recipe.ingredients || "",
      custom: recipe.custom || false,
    };
  }
}

// Helper function to get event with recipes
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

    // Get recipes with complete data including recipe_data JSONB
    const recipesResult = await pool.query(
      `SELECT id, meal_id, title, image, ingredients, instructions, custom, category, area, tags, youtube_url, source_url, recipe_data
       FROM recipes 
       WHERE event_id = $1 AND user_id = $2
       ORDER BY id DESC`,
      [eventId, userId]
    );

    // Safely reconstruct recipe data
    const recipes = recipesResult.rows.map((recipe) =>
      reconstructRecipeData(recipe)
    );

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

    // Group recipes by event_id using safe reconstruction
    const recipesByEvent = recipes.reduce((acc, recipe) => {
      if (!acc[recipe.event_id]) {
        acc[recipe.event_id] = [];
      }

      // Use the safe helper function
      const reconstructedRecipe = reconstructRecipeData(recipe);
      acc[recipe.event_id].push(reconstructedRecipe);

      return acc;
    }, {});

    // Combine events with their recipes
    const eventsWithRecipes = eventsResult.rows.map((event) => ({
      id: event.id,
      title: event.name,
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

    // Extract ingredients into readable format
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
        JSON.stringify(recipe),
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

// DELETE recipe from event
app.delete(
  "/events/:eventId/recipes/:recipeId",
  authenticateUser,
  async (req, res) => {
    const { eventId, recipeId } = req.params;

    try {
      console.log("Removing recipe from event:", {
        eventId,
        recipeId,
        userId: req.userId,
      });

      // Check if event belongs to user
      const eventCheck = await pool.query(
        "SELECT id FROM events WHERE id = $1 AND user_id = $2",
        [eventId, req.userId]
      );

      if (eventCheck.rows.length === 0) {
        return res
          .status(404)
          .json({ error: "Event not found or access denied" });
      }

      // Delete the recipe
      const result = await pool.query(
        "DELETE FROM recipes WHERE event_id = $1 AND meal_id = $2 AND user_id = $3 RETURNING id",
        [eventId, recipeId, req.userId]
      );

      if (result.rows.length === 0) {
        return res
          .status(404)
          .json({ error: "Recipe not found or access denied" });
      }

      console.log("Recipe removed successfully");

      // Return updated event with remaining recipes
      const updatedEvent = await getEventWithRecipes(eventId, req.userId);
      res.json(updatedEvent);
    } catch (error) {
      console.error("Error removing recipe:", error);
      res.status(500).json({ error: "Failed to remove recipe from event" });
    }
  }
);

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
