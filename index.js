#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import { parseString } from "xml2js";

const server = new Server({
  name: "llama-arxiv-curator",
  version: "0.1.0"
}, {
  capabilities: { tools: {} }
});

const coreCategories = ["cs.LG", "cs.AI", "cs.CL", "stat.ML"];

// Helper function to add delay between requests
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to fetch with retries
async function fetchWithRetry(url, maxRetries = 3, baseDelay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.error(`  Attempt ${attempt}/${maxRetries}: ${url}`);
      const response = await axios.get(url, { 
        timeout: 20000, // Increased timeout
        headers: {
          'User-Agent': 'LlamaArxivCurator/1.0.0 (research tool)'
        }
      });
      return response;
    } catch (error) {
      console.error(`  ✗ Attempt ${attempt} failed: ${error.message}`);
      
      if (attempt === maxRetries) {
        throw error;
      }
      
      // Exponential backoff
      const delayMs = baseDelay * Math.pow(2, attempt - 1);
      console.error(`  ⏳ Waiting ${delayMs}ms before retry...`);
      await delay(delayMs);
    }
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_all_titles",
      description: "Get ALL recent paper titles from core ML categories",
      inputSchema: {
        type: "object",
        properties: {
          papers_per_category: {
            type: "number",
            default: 100,
            maximum: 200, // Limit to prevent timeouts
            description: "Number of recent papers to fetch per category (max 200)"
          }
        }
      }
    },
    {
      name: "get_abstracts_for_papers",
      description: "Get full abstracts for specific papers",
      inputSchema: {
        type: "object",
        properties: {
          paper_urls: {
            type: "array",
            items: { type: "string" },
            maxItems: 20, // Limit batch size
            description: "List of ArXiv URLs to fetch abstracts for (max 20)"
          }
        },
        required: ["paper_urls"]
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  
  if (request.params.name === "get_all_titles") {
    try {
      let papersPerCategory = request.params.arguments?.papers_per_category || 100;
      
      // Enforce reasonable limits
      papersPerCategory = Math.min(papersPerCategory, 200);
      
      console.error(`Fetching ${papersPerCategory} titles from each category`);
      
      const allPapers = [];
      
      for (const category of coreCategories) {
        console.error(`📡 Fetching ${category}...`);
        
        const url = `http://export.arxiv.org/api/query?search_query=cat:${category}&start=0&max_results=${papersPerCategory}&sortBy=submittedDate&sortOrder=descending`;
        
        try {
          const response = await fetchWithRetry(url);
          
          const papers = await new Promise((resolve, reject) => {
            parseString(response.data, (err, result) => {
              if (err) reject(err);
              else resolve(result.feed.entry || []);
            });
          });
          
          const categoryPapers = papers.map(paper => ({
            title: paper.title[0]?.replace(/\s+/g, " ").trim(),
            authors: paper.author?.map(a => a.name[0]).join(", "),
            url: paper.id[0],
            published: paper.published[0],
            category: category
          }));
          
          allPapers.push(...categoryPapers);
          console.error(`✓ ${category}: ${categoryPapers.length} papers`);
          
          // Rate limiting - wait between categories
          if (category !== coreCategories[coreCategories.length - 1]) {
            await delay(2000); // 2 second delay between categories
          }
          
        } catch (error) {
          console.error(`✗ ${category}: ${error.message}`);
          // Continue with other categories even if one fails
        }
      }
      
      // Remove duplicates and sort
      const uniquePapers = [];
      const seenUrls = new Set();
      
      for (const paper of allPapers) {
        if (!seenUrls.has(paper.url)) {
          seenUrls.add(paper.url);
          uniquePapers.push(paper);
        }
      }
      
      const sortedPapers = uniquePapers.sort((a, b) => 
        new Date(b.published) - new Date(a.published)
      );
      
      console.error(`📊 Total unique papers: ${sortedPapers.length}`);
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total_papers: sortedPapers.length,
            papers_by_category: coreCategories.reduce((acc, cat) => {
              acc[cat] = sortedPapers.filter(p => p.category === cat).length;
              return acc;
            }, {}),
            papers: sortedPapers
          }, null, 2)
        }]
      };
      
    } catch (error) {
      console.error(`Error in get_all_titles: ${error.message}`);
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }]
      };
    }
  }
  
  if (request.params.name === "get_abstracts_for_papers") {
    try {
      let paperUrls = request.params.arguments?.paper_urls || [];
      
      // Enforce reasonable limits
      paperUrls = paperUrls.slice(0, 20);
      
      console.error(`Fetching abstracts for ${paperUrls.length} papers`);
      
      const paperDetails = [];
      
      for (let i = 0; i < paperUrls.length; i++) {
        const url = paperUrls[i];
        console.error(`📄 Fetching ${i+1}/${paperUrls.length}: ${url}`);
        
        try {
          const arxivId = url.replace('http://arxiv.org/abs/', '')
                            .replace('https://arxiv.org/abs/', '')
                            .split('/').pop();
          
          const apiUrl = `http://export.arxiv.org/api/query?id_list=${arxivId}`;
          const response = await fetchWithRetry(apiUrl, 2, 500); // Fewer retries for individual papers
          
          const papers = await new Promise((resolve, reject) => {
            parseString(response.data, (err, result) => {
              if (err) reject(err);
              else resolve(result.feed.entry || []);
            });
          });
          
          if (papers.length > 0) {
            const paper = papers[0];
            paperDetails.push({
              title: paper.title[0]?.replace(/\s+/g, " ").trim(),
              abstract: paper.summary[0]?.replace(/\s+/g, " ").trim(),
              authors: paper.author?.map(a => a.name[0]).join(", "),
              url: paper.id[0],
              published: paper.published[0],
              categories: paper.category?.map(c => c.$.term).join(", ") || "Unknown"
            });
            console.error(`  ✓ Success`);
          } else {
            console.error(`  ✗ No data found`);
          }
          
          // Rate limiting between individual papers
          if (i < paperUrls.length - 1) {
            await delay(1000); // 1 second between papers
          }
          
        } catch (error) {
          console.error(`  ✗ Failed: ${error.message}`);
          // Continue with other papers
        }
      }
      
      console.error(`📊 Successfully fetched ${paperDetails.length}/${paperUrls.length} abstracts`);
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            requested: paperUrls.length,
            fetched: paperDetails.length,
            papers: paperDetails
          }, null, 2)
        }]
      };
      
    } catch (error) {
      console.error(`Error in get_abstracts_for_papers: ${error.message}`);
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }]
      };
    }
  }
  
  // Handle unknown tool names
  throw new Error(`Unknown tool: ${request.params.name}`);
});

// Wrap in async function to handle errors better
async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("🚀 Llama ArXiv Curator MCP server ready!");
  } catch (error) {
    console.error("❌ Failed to start MCP server:", error);
    process.exit(1);
  }
}

// Handle process cleanup
process.on('SIGINT', () => {
  console.error('🔌 Shutting down MCP server...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('🔌 Shutting down MCP server...');
  process.exit(0);
});

main().catch((error) => {
  console.error("❌ Unhandled error:", error);
  process.exit(1);
});
