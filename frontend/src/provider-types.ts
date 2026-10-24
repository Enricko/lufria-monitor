export interface AgentModel {
  id: string;
  name?: string;
  provider: string;
  provider_id: string;
}

export interface Provider {
  id: string;
  name: string;
  base_url: string;
  enabled: boolean;
  api_key_configured: boolean;
  model_count: number;
  last_refreshed: number | null;
  error: string | null;
}

export interface ProviderCatalog {
  providers: Provider[];
  models: AgentModel[];
}

export interface ModelSelection {
  model: string;
  provider_id: string | null;
}
