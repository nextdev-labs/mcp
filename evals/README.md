# Nextdev MCP Evaluation Suite

This directory contains a Python-based evaluation and benchmarking suite for the Nextdev MCP server. 

Because the core server logic relies on AI models to rank API recommendations and search documentation, it's critical to have a way to quantitatively measure the accuracy of these systems over time.

## Purpose

The evaluation suite tests the behavior of the live/hosted Nextdev MCP endpoint (or a local instance) using `pytest`. It verifies that:
1. **Recommendations** (`recommend_api`): High-confidence queries return expected vendors in the top results. Nonsense queries correctly yield low confidence.
2. **Search** (`search_docs`): Semantic searches across vendor documentation return the correct reference pages.


## Setup Instructions

1. **Navigate to the `evals` directory:**
   ```bash
   cd evals
   ```

2. **Create a virtual environment:**
   ```bash
   # On Windows
   python -m venv venv
   .\venv\Scripts\activate

   # On macOS/Linux
   python3 -m venv venv
   source venv/bin/activate
   ```

3. **Install the dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

## Running the Tests

By default, the tests run against the production Nextdev MCP endpoint (`https://www.joinnextdev.com/api/mcp`). 

To run the full evaluation suite, simply run:
```bash
pytest -v
```

### Testing a Local Server

If you are running the MCP server locally (e.g. on port 3000) and want to test it instead of the production server, you can override the endpoint URL using the `NEXTDEV_MCP_URL` environment variable:

```bash
# On Windows (PowerShell)
$env:NEXTDEV_MCP_URL="http://localhost:3000/api/mcp"
pytest -v

# On macOS/Linux
NEXTDEV_MCP_URL="http://localhost:3000/api/mcp" pytest -v
```

## Adding New Tests

- **Recommendations**: Add new use cases to `test_recommend_api.py`. Provide specific scenarios and assert that the expected `slug` is returned in the `recommendations` array.
- **Search**: Add new search queries to `test_search_docs.py` targeting specific `orgSlug`s and verify that relevant documentation URLs are retrieved.