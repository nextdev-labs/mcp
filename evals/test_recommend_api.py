import pytest
from client import NextdevMCPClient

@pytest.fixture
def mcp():
    return NextdevMCPClient()

def test_recommend_identity_verification(mcp):
    res = mcp.call_tool("recommend_api", {
        "use_case": "agent-driven identity verification before payment settlement"
    })
    
    assert res is not None, "Response should not be None"
    assert "recommendations" in res, "Should contain recommendations array"
    
    recs = res["recommendations"]
    
    if res.get("confidence") == "high":
        assert len(recs) > 0, "High confidence should have results"
        
        slugs = [r.get("slug") for r in recs]
        assert any(s in slugs for s in ["agentscore", "persona"]), "Expected agentscore or persona in {}".format(slugs)

def test_recommend_no_match(mcp):
    res = mcp.call_tool("recommend_api", {
        "use_case": "flying a space shuttle to mars with a dog"
    })
    
    assert res is not None
    assert res.get("confidence") in ["low", "none"], "Non sensible query should yield low confidence"