---
name: bring
description: Manage Bring! shopping lists — view, add, remove, complete items. Use when user mentions shopping, groceries, or their shopping list.
allowed-tools: Bash(bring-cli:*)
---

# Bring! Shopping List Management

## Quick start

```bash
bring-cli lists                           # List all shopping lists
bring-cli items <list>                    # Show items on a list
bring-cli add <list> <item> [spec]        # Add item with optional details
bring-cli remove <list> <item>            # Remove item
bring-cli complete <list> <item>          # Mark as purchased
```

## Commands

### View lists and items

```bash
bring-cli lists                           # Show all available lists
bring-cli items Groceries                 # Show items on "Groceries"
bring-cli items groceries                 # Case-insensitive matching
bring-cli items groc                      # Partial name matching
```

### Add items

```bash
bring-cli add Groceries Milk              # Add "Milk"
bring-cli add Groceries Milk 2 liters     # Add "Milk" with spec "2 liters"
bring-cli add Groceries Eggs 12 pack      # Add "Eggs" with spec "12 pack"
```

### Remove and complete items

```bash
bring-cli remove Groceries Milk           # Remove from list entirely
bring-cli complete Groceries Milk         # Mark as purchased (moves to recently)
```

## List name matching

List names support case-insensitive partial matching. If the query matches multiple lists, an error is shown with the matching names.

## Output format

Output is plain text, suitable for reading. Items show their specification in parentheses when available:

```
Items on "Groceries":
  - Milk (2 liters)
  - Bread
  - Eggs (12 pack)

Recently purchased:
  - Butter
```

## Error handling

Errors are printed to stderr with exit code 1. Common errors:
- Missing credentials: `BRING_EMAIL` or `BRING_PASSWORD` not set
- Authentication failure: wrong email/password
- List not found: no list matches the given name
- Ambiguous match: multiple lists match the partial name
