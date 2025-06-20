# Your Personal ArXiv Curator

Curates recent ArXiv papers based on your preferences! This repo has been instantiated to search for papers about AI alignment, but you can edit the prompt template in simple_curator.js.

## Setup

```bash
# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# Pull model
ollama pull llama3.2:1b

# Install dependencies
npm install
```

## Usage

**Terminal 1 - Start Ollama:**
```bash
ollama serve
```

**Terminal 2 - Run curator:**
```bash
node simple_curator.js --papers 100 --days 3 --candidates 10 --min-score 5
```

**Options:**
- `--papers`: Papers per category (default: 50)
- `--days`: Days back to search (default: 2) 
- `--candidates`: Max papers to analyze (default: 10)
- `--min-score`: Minimum Llama score 1-10 (default: 5)

**What it does:**
1. Fetches recent ArXiv papers from ML categories
2. Filters by keywords (alignment, reward, RLHF, etc.)
3. Gets abstracts for top candidates
4. Scores each paper 1-10 using Llama 3.2 1B
5. Shows papers above your minimum score
