export interface TwentyConfig {
  apiKey: string;
  baseUrl: string;
}

export interface ListParams {
  limit?: number;
  cursor?: string;
  filter?: Record<string, unknown>;
  orderBy?: string;
}

export interface TwentyResponse<T> {
  data: T;
  pageInfo?: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
}

export class TwentyClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(config: TwentyConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}/rest/${path}`;
    const options: RequestInit = {
      method,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
    };
    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Twenty API ${method} ${path} failed (${response.status}): ${text}`);
    }
    return response.json() as Promise<T>;
  }

  async list(object: string, params?: ListParams): Promise<TwentyResponse<Record<string, unknown>[]>> {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.cursor) query.set('cursor', params.cursor);
    if (params?.orderBy) query.set('order_by', params.orderBy);
    if (params?.filter) {
      for (const [key, value] of Object.entries(params.filter)) {
        if (typeof value === 'object' && value !== null) {
          for (const [op, val] of Object.entries(value as Record<string, unknown>)) {
            query.set(`filter[${key}][${op}]`, String(val));
          }
        } else {
          query.set(`filter[${key}][eq]`, String(value));
        }
      }
    }
    const qs = query.toString();
    const path = qs ? `${object}?${qs}` : object;
    const result = await this.request<{ data: Record<string, Record<string, unknown>[]> }>('GET', path);
    const key = Object.keys(result.data)[0];
    return { data: result.data[key] || [] };
  }

  async get(object: string, id: string): Promise<Record<string, unknown>> {
    const result = await this.request<{ data: Record<string, Record<string, unknown>> }>('GET', `${object}/${id}`);
    const key = Object.keys(result.data)[0];
    return result.data[key];
  }

  async create(object: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.request<{ data: Record<string, Record<string, unknown>> }>('POST', object, data);
    const key = Object.keys(result.data)[0];
    return result.data[key];
  }

  async update(object: string, id: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.request<{ data: Record<string, Record<string, unknown>> }>('PATCH', `${object}/${id}`, data);
    const key = Object.keys(result.data)[0];
    return result.data[key];
  }

  async delete(object: string, id: string): Promise<Record<string, unknown>> {
    const result = await this.request<{ data: Record<string, unknown> }>('DELETE', `${object}/${id}`);
    return result.data;
  }

  async search(object: string, query: string, limit?: number): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams();
    params.set('filter[searchVector][like]', `%${query}%`);
    if (limit) params.set('limit', String(limit));
    const result = await this.request<{ data: Record<string, Record<string, unknown>[]> }>('GET', `${object}?${params}`);
    const key = Object.keys(result.data)[0];
    return result.data[key] || [];
  }

  async listMetadataObjects(): Promise<Record<string, unknown>[]> {
    const result = await this.request<{ data: { objects: Record<string, unknown>[] } }>('GET', 'metadata/objects');
    return result.data.objects;
  }
}
