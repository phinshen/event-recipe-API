// Add TheMealDB recipe to event - IMPROVED VERSION
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

    // Validate input
    if (!recipe || !recipe.idMeal || !recipe.strMeal) {
      return res.status(400).json({
        error: "Invalid recipe data. Missing required fields.",
      });
    }

    // Verify event belongs to user
    const eventCheck = await pool.query(
      "SELECT id FROM events WHERE id = $1 AND user_id = $2",
      [id, req.userId]
    );

    if (eventCheck.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Event not found or access denied" });
    }

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

    // Extract and format ingredients from TheMealDB format
    const ingredients = [];
    for (let i = 1; i <= 20; i++) {
      const ingredient = recipe[`strIngredient${i}`];
      const measure = recipe[`strMeasure${i}`];
      if (ingredient && ingredient.trim()) {
        ingredients.push(
          `${measure ? measure.trim() + " " : ""}${ingredient.trim()}`
        );
      }
    }
    const ingredientsText = ingredients.join(", ");

    // Insert recipe with properly formatted data
    const insertResult = await pool.query(
      `INSERT INTO recipes (event_id, meal_id, title, image, ingredients, instructions, custom) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) 
       RETURNING *`,
      [
        id,
        recipe.idMeal,
        recipe.strMeal,
        recipe.strMealThumb || "",
        ingredientsText,
        recipe.strInstructions || "",
        false,
      ]
    );

    console.log("Recipe inserted successfully:", insertResult.rows[0]);

    // Get updated event with recipes
    const updatedEvent = await getEventWithRecipes(id, req.userId);
    res.json(updatedEvent);

    console.log("Recipe successfully added to event");
  } catch (error) {
    console.error("Error adding recipe to event:", {
      message: error.message,
      stack: error.stack,
      code: error.code,
      detail: error.detail,
    });

    // More specific error handling
    if (error.code === "23505") {
      // Unique constraint violation
      return res.status(409).json({
        error: "Recipe already exists in this event",
      });
    }

    if (error.code === "23503") {
      // Foreign key constraint violation
      return res.status(400).json({
        error: "Invalid event or recipe data",
      });
    }

    res.status(500).json({
      error: "Failed to add recipe",
      details:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
});
