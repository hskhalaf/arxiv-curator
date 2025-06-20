#!/usr/bin/env node
import { spawn } from "child_process";
import axios from "axios";

class SimpleLlamaArxivCurator {
  constructor() {
    this.serverProcess = null;
    this.messageId = 1;
    this.pendingRequests = new Map();
    this.buffer = ''; // Buffer for handling large JSON responses
  }

  async connect() {
    console.log("🚀 Starting Llama ArXiv Curator MCP server...");
    
    this.serverProcess = spawn("node", ["index.js"], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    
    this.serverProcess.stderr.on('data', (data) => {
      console.log('📥 Server:', data.toString().trim());
    });
    
    this.serverProcess.stdout.on('data', (data) => {
      // Handle potentially large JSON responses that might come in chunks
      if (!this.buffer) this.buffer = '';
      this.buffer += data.toString();
      
      // Process complete JSON messages
      let lines = this.buffer.split('\n');
      this.buffer = lines.pop(); // Keep incomplete line in buffer
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line.trim());
            if (parsed.id && this.pendingRequests.has(parsed.id)) {
              const { resolve, reject } = this.pendingRequests.get(parsed.id);
              this.pendingRequests.delete(parsed.id);
              if (parsed.error) {
                reject(new Error(parsed.error.message || 'Unknown error'));
              } else {
                resolve(parsed.result);
              }
            }
          } catch (e) {
            // Ignore non-JSON output or partial JSON
          }
        }
      }
    });
    
    this.serverProcess.on('error', (err) => {
      console.error('❌ Process error:', err);
      throw err;
    });
    
    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Initialize connection
    await this.sendRequest('initialize', {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "llama-curator", version: "1.0.0" }
    });
    
    console.log("✅ Connected to MCP server");
  }

  async sendRequest(method, params = {}) {
    const id = this.messageId++;
    const message = {
      jsonrpc: "2.0",
      id: id,
      method: method,
      params: params
    };
    
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.serverProcess.stdin.write(JSON.stringify(message) + '\n');
      
      // Timeout after 60 seconds (longer for large datasets)
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 60000);
    });
  }

  async disconnect() {
    if (this.serverProcess) {
      this.serverProcess.kill();
      this.serverProcess = null;
      console.log("🔌 Disconnected from server");
    }
  }

  async fetchTitles(papersPerCategory = 50) {
    console.log('🔄 Requesting titles from server...');
    const result = await this.sendRequest('tools/call', {
      name: "get_all_titles",
      arguments: { papers_per_category: papersPerCategory }
    });
    console.log('✅ Received titles response');
    return JSON.parse(result.content[0].text);
  }

  async fetchAbstracts(paperUrls) {
    const result = await this.sendRequest('tools/call', {
      name: "get_abstracts_for_papers",
      arguments: { paper_urls: paperUrls }
    });
    return JSON.parse(result.content[0].text);
  }

  async analyzeWithLlama(paper) {
    try {
      const prompt = `You are helping an AI alignment researcher evaluate papers.

RESEARCHER PROFILE:
- PhD student at Harvard studying AI alignment
- Research focus: inference-time reward hacking, RLHF alternatives, alignment evaluation
- Recent work: "Inference-Time Reward Hacking in Large Language Models", "AI Alignment at Your Discretion"

PAPER TO EVALUATE:
Title: ${paper.title}
Authors: ${paper.authors}
Abstract: ${paper.abstract}

Rate this paper's relevance (1-10) to the researcher's work and explain why in 2-3 sentences.

Focus on:
- Direct relevance to inference-time alignment methods
- Novel evaluation approaches for alignment
- Understanding of reward hacking or RLHF failure modes
- Methodological insights applicable to alignment research

Response format: "Score: X/10 - [brief explanation]"`;

      const response = await axios.post('http://localhost:11434/api/generate', {
        model: 'llama3.2:1b',
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.1,
          top_p: 0.9,
          num_predict: 200
        }
      });

      const result = response.data.response;
      const scoreMatch = result.match(/Score:\s*(\d+)/);
      const score = scoreMatch ? parseInt(scoreMatch[1]) : 0;
      
      return {
        score: score,
        reasoning: result.replace(/Score:\s*\d+\/10\s*-\s*/, '').trim(),
        full_response: result
      };
      
    } catch (error) {
      console.error(`❌ Llama analysis failed: ${error.message}`);
      return {
        score: 0,
        reasoning: "Analysis failed - Make sure Ollama is running with 'ollama serve'",
        full_response: "Error"
      };
    }
  }

  async curatePapers(options = {}) {
    const {
      papersPerCategory = 50,
      daysBack = 2,
      maxCandidates = 10,
      minScore = 5
    } = options;

    try {
      // Stage 1: Get all titles
      console.log("\n🔍 STAGE 1: Fetching recent titles...");
      const titleData = await this.fetchTitles(papersPerCategory);
      
      // Filter by date
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysBack);
      
      const recentPapers = titleData.papers.filter(paper => {
        const paperDate = new Date(paper.published);
        return paperDate >= cutoffDate;
      });
      
      console.log(`Found ${recentPapers.length} papers from last ${daysBack} days`);
      
      // Stage 2: Filter titles with keywords
      console.log("\n🎯 STAGE 2: Filtering by keywords...");
      const keywords = [
        "reward", "rlhf", "alignment", "preference", "human feedback",
        "constitutional", "safety", "robustness", "evaluation", "benchmark",
        "inference", "post-training", "fine-tuning"
      ];
      
      const candidates = recentPapers.filter(paper => {
        const text = `${paper.title} ${paper.authors}`.toLowerCase();
        return keywords.some(keyword => text.includes(keyword));
      }).slice(0, maxCandidates);
      
      console.log(`Found ${candidates.length} keyword-filtered candidates`);
      
      if (candidates.length === 0) {
        console.log("❌ No relevant papers found in keyword filtering");
        return { 
          total_scanned: titleData.total_papers,
          recent_papers: recentPapers.length,
          days_back: daysBack,
          candidates: 0,
          analyzed: [], 
          relevant: [] 
        };
      }
      
      // Stage 3: Get abstracts
      console.log("\n📖 STAGE 3: Fetching abstracts...");
      const paperUrls = candidates.map(p => p.url);
      const abstractData = await this.fetchAbstracts(paperUrls);
      
      console.log(`✅ Retrieved ${abstractData.fetched} abstracts`);
      
      // Stage 4: Llama analysis
      console.log("\n🦙 STAGE 4: Llama 3.2 1B analysis...");
      const analyzedPapers = [];
      
      for (let i = 0; i < abstractData.papers.length; i++) {
        const paper = abstractData.papers[i];
        console.log(`🤖 Analyzing ${i+1}/${abstractData.papers.length}: ${paper.title.substring(0, 50)}...`);
        
        const analysis = await this.analyzeWithLlama(paper);
        
        analyzedPapers.push({
          ...paper,
          llama_score: analysis.score,
          llama_reasoning: analysis.reasoning,
          llama_full_response: analysis.full_response
        });
        
        // Don't overwhelm Ollama
        if (i < abstractData.papers.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      // Filter by Llama score
      const relevantPapers = analyzedPapers
        .filter(paper => paper.llama_score >= minScore)
        .sort((a, b) => b.llama_score - a.llama_score);
      
      console.log(`✅ Found ${relevantPapers.length} papers scoring ${minScore}+ points`);
      
      return {
        total_scanned: titleData.total_papers,
        recent_papers: recentPapers.length,
        days_back: daysBack,
        candidates: candidates.length,
        analyzed: analyzedPapers,
        relevant: relevantPapers
      };
      
    } catch (error) {
      console.error("❌ Curation failed:", error.message);
      throw error;
    }
  }

  displayResults(results) {
    console.log("\n" + "=".repeat(80));
    console.log("🦙 LLAMA-POWERED ARXIV CURATOR RESULTS");
    console.log("=".repeat(80));
    
    if (results.relevant.length === 0) {
      console.log("❌ No highly relevant papers found");
      console.log("\n💡 Try:");
      console.log("  - Lowering --min-score (current minimum)")
      console.log("  - Increasing --candidates or --days");
      console.log("  - Check if Ollama is running: ollama serve");
      return;
    }
    
    results.relevant.forEach((paper, i) => {
      console.log(`\n📄 PAPER ${i+1} - Llama Score: ${paper.llama_score}/10`);
      console.log(`Title: ${paper.title}`);
      console.log(`Authors: ${paper.authors}`);
      console.log(`Published: ${paper.published.split('T')[0]}`);
      console.log(`Categories: ${paper.categories}`);
      console.log(`URL: ${paper.url}`);
      console.log(`\n🦙 Llama Analysis: ${paper.llama_reasoning}`);
      console.log(`\n📝 Abstract: ${paper.abstract.substring(0, 400)}...`);
      console.log("\n" + "-".repeat(80));
    });
    
    console.log(`\n📊 SUMMARY:`);
    console.log(`📚 Total papers scanned: ${results.total_scanned}`);
    console.log(`📅 Recent papers (last ${results.recent_papers} days): ${results.recent_papers}`);
    console.log(`🎯 Keyword candidates: ${results.candidates}`);
    console.log(`🦙 Llama analyzed: ${results.analyzed.length}`);
    console.log(`⭐ Highly relevant: ${results.relevant.length}`);
    
    if (results.analyzed.length > 0) {
      const avgScore = results.analyzed.reduce((sum, p) => sum + p.llama_score, 0) / results.analyzed.length;
      console.log(`📈 Average Llama score: ${avgScore.toFixed(1)}/10`);
    }
  }
}

async function main() {
  const curator = new SimpleLlamaArxivCurator();
  
  process.on('SIGINT', async () => {
    console.log('\n👋 Shutting down Llama ArXiv Curator...');
    await curator.disconnect();
    process.exit(0);
  });
  
  try {
    await curator.connect();
    
    // Parse arguments
    const args = process.argv.slice(2);
    const papers = args.includes('--papers') ? 
      parseInt(args[args.indexOf('--papers') + 1]) : 50;
    const days = args.includes('--days') ? 
      parseInt(args[args.indexOf('--days') + 1]) : 2;
    const candidates = args.includes('--candidates') ? 
      parseInt(args[args.indexOf('--candidates') + 1]) : 10;
    const minScore = args.includes('--min-score') ? 
      parseInt(args[args.indexOf('--min-score') + 1]) : 5;
    
    console.log(`\n🎯 LLAMA ARXIV CURATOR CONFIGURATION:`);
    console.log(`📚 Papers per category: ${papers}`);
    console.log(`📅 Days back: ${days}`);
    console.log(`🎯 Max candidates: ${candidates}`);
    console.log(`⭐ Min Llama score: ${minScore}`);
    console.log(`🦙 Model: Llama 3.2 1B Instruct`);
    
    const results = await curator.curatePapers({
      papersPerCategory: papers,
      daysBack: days,
      maxCandidates: candidates,
      minScore: minScore
    });
    
    curator.displayResults(results, days);
    
  } catch (error) {
    console.error("💥 Error:", error.message);
    console.log("\n🔧 Troubleshooting:");
    console.log("  1. Make sure Ollama is running: ollama serve");
    console.log("  2. Check if model is installed: ollama list");
    console.log("  3. Pull model if needed: ollama pull llama3.2:1b");
  } finally {
    await curator.disconnect();
  }
}

main();
