// In your backend (paste.txt), update the POST /events/:id/recipes endpoint:

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

// Also update the getEventWithRecipes helper function:
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
        strCategory: recipe.category || storedData.strCategory || "Unknown",
        strArea: recipe.area || storedData.strArea || "Unknown",
        strTags: recipe.tags || storedData.strTags || "",
        strYoutube: recipe.youtube_url || storedData.strYoutube || "",
        strSource: recipe.source_url || storedData.strSource || "",
        strInstructions: recipe.instructions,
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
