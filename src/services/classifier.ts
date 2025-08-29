interface ClassificationResult {
  category: string;
  priority: 'urgent' | 'high' | 'medium' | 'low';
  confidence: number;
  reasoning: string;
  provider: string;
}

interface AIProvider {
  name: string;
  classify: (content: string) => Promise<ClassificationResult>;
}

export class TicketClassifier {
  private providers: AIProvider[] = [];

  constructor(private env: any) {
    // Initialize providers in order of preference
    this.initializeProviders();
  }

  private initializeProviders() {
    // Claude provider (primary)
    if (this.env.CLAUDE_API_KEY) {
      this.providers.push({
        name: 'claude',
        classify: this.classifyWithClaude.bind(this)
      });
    }

    // OpenAI provider (secondary)  
    if (this.env.OPENAI_API_KEY) {
      this.providers.push({
        name: 'openai', 
        classify: this.classifyWithOpenAI.bind(this)
      });
    }

    // Mistral provider (tertiary)
    if (this.env.MISTRAL_API_KEY) {
      this.providers.push({
        name: 'mistral',
        classify: this.classifyWithMistral.bind(this)
      });
    }

    // Rules-based fallback
    this.providers.push({
      name: 'rules',
      classify: this.classifyWithRules.bind(this)
    });
  }

  async classify(ticketContent: string): Promise<ClassificationResult> {
    for (const provider of this.providers) {
      try {
        const result = await provider.classify(ticketContent);
        return result;
      } catch (error) {
        console.warn(`Provider ${provider.name} failed:`, error);
        continue;
      }
    }
    
    throw new Error('All classification providers failed');
  }

  private async classifyWithClaude(content: string): Promise<ClassificationResult> {
    // Claude API implementation - we'll build this next
    throw new Error('Claude provider not implemented yet');
  }

  private async classifyWithOpenAI(content: string): Promise<ClassificationResult> {
    // OpenAI API implementation - we'll build this next
    throw new Error('OpenAI provider not implemented yet');
  }

  private async classifyWithMistral(content: string): Promise<ClassificationResult> {
    // Mistral API implementation - we'll build this next
    throw new Error('Mistral provider not implemented yet');
  }

  private async classifyWithRules(content: string): Promise<ClassificationResult> {
    // Emergency rule-based classification
    const urgentKeywords = ['urgent', 'critical', 'down', 'outage', 'broken'];
    const isUrgent = urgentKeywords.some(keyword => 
      content.toLowerCase().includes(keyword)
    );

    return {
      category: 'technical',
      priority: isUrgent ? 'urgent' : 'medium',
      confidence: 0.6,
      reasoning: 'Rule-based classification fallback',
      provider: 'rules'
    };
  }
}
