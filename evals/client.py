import os
import requests
import json

class NextdevMCPClient:
    def __init__(self, endpoint_url=None):
        self.endpoint_url = endpoint_url or os.environ.get("NEXTDEV_MCP_URL", "https://www.joinnextdev.com/api/mcp")

    def call_tool(self, tool_name, args):
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": args
            }
        }
        
        response = requests.post(
            self.endpoint_url,
            headers={"Content-Type": "application/json"},
            json=payload,
            timeout=15
        )
        response.raise_for_status()
        result = response.json()
        
        if "error" in result:
            raise Exception("MCP RPC Error: {}".format(result['error']))
            
        content = result.get("result", {}).get("content", [])
        if not content:
            return None
            
        text_content = content[0].get("text", "")
        try:
            return json.loads(text_content)
        except json.JSONDecodeError:
            return text_content