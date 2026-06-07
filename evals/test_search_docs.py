import pytest
from client import NextdevMCPClient

@pytest.fixture
def mcp():
    return NextdevMCPClient()

def test_search_docs_stripe_webhook(mcp):
    res = mcp.call_tool("search_docs", {
        "orgSlug": "stripe",
        "query": "refund webhook"
    })
    
    assert res is not None
    assert "results" in res, "Response should have a results array"
    
    results = res["results"]
    assert len(results) > 0, "Should return search results for Stripe webhooks"
    
    found_relevant = False
    for r in results:
        title = r.get("title", "").lower()
        url = r.get("url", "").lower()
        if "webhook" in title or "webhook" in url or "refund" in title:
            found_relevant = True
            break
            
    assert found_relevant, "None of the results seem relevant to webhooks: {}".format(results)