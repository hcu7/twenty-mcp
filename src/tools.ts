import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TwentyClient } from './twenty-client.js';

interface ObjectDef {
  name: string;
  plural: string;
  description: string;
  createFields: Record<string, z.ZodType>;
  updateFields: Record<string, z.ZodType>;
  searchable: boolean;
}

function registerCrudTools(server: McpServer, client: TwentyClient, obj: ObjectDef) {
  const { name, plural, description } = obj;

  // List
  server.tool(
    `list_${plural}`,
    `List ${plural} in Twenty CRM. ${description}`,
    {
      limit: z.number().optional().describe('Max number of records (default 20)'),
      cursor: z.string().optional().describe('Pagination cursor for next page'),
    },
    async ({ limit, cursor }) => {
      const result = await client.list(plural, { limit: limit ?? 20, cursor });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    }
  );

  // Get by ID
  server.tool(
    `get_${name}`,
    `Get a single ${name} by ID from Twenty CRM`,
    {
      id: z.string().describe(`The ${name} ID (UUID)`),
    },
    async ({ id }) => {
      const result = await client.get(plural, id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Create
  server.tool(
    `create_${name}`,
    `Create a new ${name} in Twenty CRM`,
    obj.createFields,
    async (params) => {
      const result = await client.create(plural, params);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Update
  server.tool(
    `update_${name}`,
    `Update an existing ${name} in Twenty CRM`,
    {
      id: z.string().describe(`The ${name} ID (UUID)`),
      ...obj.updateFields,
    },
    async ({ id, ...data }) => {
      const result = await client.update(plural, id, data);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Delete
  server.tool(
    `delete_${name}`,
    `Delete a ${name} from Twenty CRM (soft delete)`,
    {
      id: z.string().describe(`The ${name} ID (UUID)`),
    },
    async ({ id }) => {
      const result = await client.delete(plural, id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Search
  if (obj.searchable) {
    server.tool(
      `search_${plural}`,
      `Search ${plural} in Twenty CRM by text query`,
      {
        query: z.string().describe('Search query text'),
        limit: z.number().optional().describe('Max results (default 10)'),
      },
      async ({ query, limit }) => {
        const results = await client.search(plural, query, limit ?? 10);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
        };
      }
    );
  }
}

// --- Object Definitions ---

const nameSchema = z.object({
  firstName: z.string().describe('First name'),
  lastName: z.string().describe('Last name'),
}).describe('Person name');

const emailsSchema = z.object({
  primaryEmail: z.string().optional().describe('Primary email address'),
}).optional().describe('Email addresses');

const phonesSchema = z.object({
  primaryPhoneNumber: z.string().optional().describe('Primary phone number'),
  primaryPhoneCountryCode: z.string().optional().describe('Country code (e.g. +49)'),
}).optional().describe('Phone numbers');

const linkSchema = z.object({
  primaryLinkUrl: z.string().optional().describe('Primary URL'),
  primaryLinkLabel: z.string().optional().describe('URL label'),
}).optional().describe('Links');

const addressSchema = z.object({
  addressStreet1: z.string().optional(),
  addressStreet2: z.string().optional(),
  addressCity: z.string().optional(),
  addressState: z.string().optional(),
  addressPostcode: z.string().optional(),
  addressCountry: z.string().optional(),
}).optional().describe('Address');

const objects: ObjectDef[] = [
  {
    name: 'person',
    plural: 'people',
    description: 'Contacts/persons in the CRM',
    createFields: {
      name: nameSchema,
      emails: emailsSchema,
      phones: phonesSchema,
      city: z.string().optional().describe('City'),
      jobTitle: z.string().optional().describe('Job title'),
      companyId: z.string().optional().describe('Associated company ID'),
    },
    updateFields: {
      name: nameSchema.optional(),
      emails: emailsSchema,
      phones: phonesSchema,
      city: z.string().optional().describe('City'),
      jobTitle: z.string().optional().describe('Job title'),
      companyId: z.string().optional().describe('Associated company ID'),
    },
    searchable: true,
  },
  {
    name: 'company',
    plural: 'companies',
    description: 'Companies/organizations in the CRM',
    createFields: {
      name: z.string().describe('Company name'),
      domainName: linkSchema,
      address: addressSchema,
      employees: z.number().optional().describe('Number of employees'),
      idealCustomerProfile: z.boolean().optional().describe('Is ideal customer profile'),
    },
    updateFields: {
      name: z.string().optional().describe('Company name'),
      domainName: linkSchema,
      address: addressSchema,
      employees: z.number().optional().describe('Number of employees'),
      idealCustomerProfile: z.boolean().optional().describe('Is ideal customer profile'),
    },
    searchable: true,
  },
  {
    name: 'opportunity',
    plural: 'opportunities',
    description: 'Sales opportunities/deals in the pipeline',
    createFields: {
      name: z.string().describe('Opportunity name'),
      stage: z.string().optional().describe('Pipeline stage'),
      amount: z.object({
        amountMicros: z.number().describe('Amount in micros (e.g. 1000000 = 1.00)'),
        currencyCode: z.string().describe('Currency code (e.g. EUR)'),
      }).optional().describe('Deal amount'),
      closeDate: z.string().optional().describe('Expected close date (ISO 8601)'),
      companyId: z.string().optional().describe('Associated company ID'),
      pointOfContactId: z.string().optional().describe('Point of contact person ID'),
    },
    updateFields: {
      name: z.string().optional().describe('Opportunity name'),
      stage: z.string().optional().describe('Pipeline stage'),
      amount: z.object({
        amountMicros: z.number().describe('Amount in micros'),
        currencyCode: z.string().describe('Currency code'),
      }).optional().describe('Deal amount'),
      closeDate: z.string().optional().describe('Expected close date (ISO 8601)'),
      companyId: z.string().optional().describe('Associated company ID'),
      pointOfContactId: z.string().optional().describe('Point of contact person ID'),
    },
    searchable: true,
  },
  {
    name: 'task',
    plural: 'tasks',
    description: 'Tasks and to-dos',
    createFields: {
      title: z.string().describe('Task title'),
      body: z.string().optional().describe('Task description'),
      status: z.string().optional().describe('Task status'),
      dueAt: z.string().optional().describe('Due date (ISO 8601)'),
      assigneeId: z.string().optional().describe('Assigned workspace member ID'),
    },
    updateFields: {
      title: z.string().optional().describe('Task title'),
      body: z.string().optional().describe('Task description'),
      status: z.string().optional().describe('Task status'),
      dueAt: z.string().optional().describe('Due date (ISO 8601)'),
      assigneeId: z.string().optional().describe('Assigned workspace member ID'),
    },
    searchable: true,
  },
  {
    name: 'note',
    plural: 'notes',
    description: 'Notes attached to records',
    createFields: {
      title: z.string().describe('Note title'),
      body: z.string().optional().describe('Note content'),
    },
    updateFields: {
      title: z.string().optional().describe('Note title'),
      body: z.string().optional().describe('Note content'),
    },
    searchable: true,
  },
];

export function registerAllTools(server: McpServer, client: TwentyClient) {
  // Register CRUD + search for all objects
  for (const obj of objects) {
    registerCrudTools(server, client, obj);
  }

  // Metadata: list all objects in the workspace
  server.tool(
    'list_metadata_objects',
    'List all object types available in the Twenty CRM workspace (including custom objects)',
    {},
    async () => {
      const objects = await client.listMetadataObjects();
      const summary = objects.map((o: Record<string, unknown>) => ({
        name: o.nameSingular,
        label: o.labelSingular,
        isCustom: o.isCustom,
        isActive: o.isActive,
      }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
      };
    }
  );

  // Generic: query any object by its plural name
  server.tool(
    'query_object',
    'Query any Twenty CRM object by its plural REST name (e.g. "people", "companies", "workflows"). Useful for custom objects or objects not covered by the dedicated tools.',
    {
      object: z.string().describe('Plural object name (e.g. "people", "companies", "workflows", "prospects")'),
      limit: z.number().optional().describe('Max records (default 20)'),
      cursor: z.string().optional().describe('Pagination cursor'),
    },
    async ({ object, limit, cursor }) => {
      const result = await client.list(object, { limit: limit ?? 20, cursor });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    }
  );
}
