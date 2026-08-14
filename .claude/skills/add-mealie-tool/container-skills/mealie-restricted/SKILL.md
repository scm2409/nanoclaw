---
name: mealie-restricted
description: Use a Mealie MCP server running in restricted mode (search, read, create recipes, meal-plan writes, cookbook reads) — no update/delete of existing recipes, no cookbook or taxonomy mutation. Use whenever calling any `mealie` tool, so you don't retry a tool that doesn't exist here or report its absence as a failure.
---

# Mealie in restricted mode

This server runs Martin's fork of `mcp-mealie` with `MEALIE_RESTRICTED_MODE`
set. Restricted mode filters tools **at registration time** — a blocked tool
never appears in your tool list at all. If you don't see a tool below, it
isn't a bug and it isn't worth retrying with different arguments; it's
switched off on purpose.

## What you have

Recipes: `search_recipes`, `get_recipe`, `suggest_recipes`, `create_recipe`,
`add_recipe_note`, `import_recipe_from_url`.

Meal plan (full access, not filtered by restricted mode): `get_meal_plan`,
`get_todays_meals`, `add_meal_plan_entry`, `delete_meal_plan_entry`,
`random_meal_plan`.

Cookbooks (read-only): `list_cookbooks`, `get_cookbook_recipes`.

Library (always read-only, not affected by any mode): `library_stats`,
`find_duplicate_recipes`, `check_recipe_links`.

Other: `parse_ingredients`, `manage_taxonomy` (see below — present, but
narrowed).

## What you don't have, and why that's fine

`update_recipe`, `set_recipe_image`, `upload_recipe_image`,
`bulk_tag_recipes`, `delete_recipe` — recipe mutation and deletion.
`create_cookbook`, `update_cookbook`, `delete_cookbook` — cookbook
mutation. None of these are in your tool list. There is no error to catch
for them; they simply don't exist for this session.

## `add_recipe_note` is append-only

This is your way to annotate an existing recipe without `update_recipe`. It
adds a note; it does not let you rewrite the recipe's other fields. If a
task needs an existing field changed (ingredients, instructions, title),
that's outside what this server lets you do here — say so rather than
working around it with a note.

## `manage_taxonomy` is present but narrowed

It only accepts `action="list"` in this mode. Any other action returns an
error to the effect of "server is in restricted mode — only 'list' is
allowed." That error is the gate working as designed, not a bug to report
up as broken.

## Startup preflight

Before this server accepts any tool call, it checks reachability
(`/api/app/about`) and auth (`/api/users/self`) against the Mealie
instance. If either fails, the server exits before the stdio transport
comes up — so a credential or network problem shows up as *the server never
starting* for your very first call, not as a tool-level error. If your
first call in a session fails outright, that's the shape of a routing or
auth problem upstream, not something to retry with different arguments.

## Content language

This instance has an operator-set content language for what gets written
into it — see your operating instructions for the specific language and
where the exception (imported recipes) applies. This skill only covers the
tool surface, not that policy.
