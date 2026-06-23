/**
 * GoHighLevel Affiliates Tools
 *
 * Rewritten 2026-06-23 (_AFFILIATE_BACKEND_V1): the public affiliate API
 * (services.leadconnectorhq.com/affiliates/...) is DEAD (404). These tools now call the internal
 * Affiliate Manager backend via AffiliateBuilderClient — LOCATION-SCOPED routes verified live on BizDev.
 *
 * v1 ships ONLY live-verified operations. Deliberately omitted until their schemas/paths are reverse-
 * engineered (see AFFILIATE_PROGRAM_PROJECT.md): campaign CREATE (backend requires a pre-configured
 * email template — do it in the GHL UI / via snapshot), campaign UPDATE, affiliate campaign/tier
 * assignment, and external-lead attribution (real path not under /affiliate-manager).
 *
 * Interface (constructor(ghlClient) / getToolDefinitions() / handleToolCall()) is UNCHANGED so the
 * existing tool-registry wiring keeps working. ghlClient is still used for the default locationId.
 */
import { AffiliateBuilderClient } from '../clients/affiliate-builder-client.js';

export class AffiliatesTools {
  private ghlClient: any;
  private aff: AffiliateBuilderClient | null = null;

  constructor(ghlClient: any) {
    this.ghlClient = ghlClient;
  }

  private client(): AffiliateBuilderClient {
    if (!this.aff) this.aff = AffiliateBuilderClient.fromEnv();
    return this.aff;
  }

  private loc(args: any): string {
    if (args && args.locationId) return String(args.locationId);
    try {
      const c = this.ghlClient?.getConfig?.();
      if (c?.locationId) return String(c.locationId);
    } catch { /* fall through */ }
    return this.client().getLocationId();
  }

  getToolDefinitions() {
    const cat = (access: string) => ({ labels: { category: 'affiliates', access, complexity: 'simple' } });
    return [
      // ── Read: program state ───────────────────────────────
      {
        name: 'get_affiliate_overview',
        description: 'Affiliate program overview for a location (campaign + affiliate summary + config) via /init',
        inputSchema: { type: 'object', properties: { locationId: { type: 'string' } } },
        _meta: cat('read'),
      },
      {
        name: 'get_affiliate_campaigns',
        description: 'List affiliate campaigns (Sales + Lead) for a location, with transactions/meta',
        inputSchema: { type: 'object', properties: { locationId: { type: 'string', description: 'Location ID' } } },
        _meta: cat('read'),
      },
      {
        name: 'get_affiliate_campaign',
        description: 'Get one affiliate campaign by id (full config incl. commissionV2/leadCommissionV2, referral links)',
        inputSchema: { type: 'object', properties: { campaignId: { type: 'string' }, locationId: { type: 'string' } }, required: ['campaignId'] },
        _meta: cat('read'),
      },
      {
        name: 'get_affiliates',
        description: 'List affiliates for a location',
        inputSchema: { type: 'object', properties: { locationId: { type: 'string' } } },
        _meta: cat('read'),
      },
      {
        name: 'get_affiliate',
        description: 'Get one affiliate by id (incl. revenue, tier, campaignIds, contact link)',
        inputSchema: { type: 'object', properties: { affiliateId: { type: 'string' }, locationId: { type: 'string' } }, required: ['affiliateId'] },
        _meta: cat('read'),
      },
      {
        name: 'get_affiliate_stats',
        description: 'Affiliate performance (revenue/tier/referral counts) — from the affiliate record',
        inputSchema: { type: 'object', properties: { affiliateId: { type: 'string' }, locationId: { type: 'string' } }, required: ['affiliateId'] },
        _meta: cat('read'),
      },
      {
        name: 'get_payouts',
        description: 'List affiliate payouts for a location',
        inputSchema: { type: 'object', properties: { locationId: { type: 'string' } } },
        _meta: cat('read'),
      },
      {
        name: 'get_referrals',
        description: 'List affiliate referral transactions (leads/sales) for a location',
        inputSchema: { type: 'object', properties: { locationId: { type: 'string' } } },
        _meta: cat('read'),
      },
      // ── Write: affiliate roster (verified) ────────────────
      {
        name: 'create_affiliate',
        description: 'Add an affiliate by email (optionally name/phone). Campaign enrollment + tier are configured separately after creation.',
        inputSchema: {
          type: 'object',
          properties: {
            locationId: { type: 'string' },
            email: { type: 'string', description: 'Affiliate email (required)' },
            firstName: { type: 'string' },
            lastName: { type: 'string' },
            phone: { type: 'string' },
          },
          required: ['email'],
        },
        _meta: cat('write'),
      },
      {
        name: 'delete_affiliate',
        description: 'Remove an affiliate',
        inputSchema: { type: 'object', properties: { affiliateId: { type: 'string' }, locationId: { type: 'string' } }, required: ['affiliateId'] },
        _meta: cat('delete'),
      },
      {
        name: 'delete_affiliate_campaign',
        description: 'Delete an affiliate campaign',
        inputSchema: { type: 'object', properties: { campaignId: { type: 'string' }, locationId: { type: 'string' } }, required: ['campaignId'] },
        _meta: cat('delete'),
      },
    ];
  }

  async handleToolCall(toolName: string, args: any): Promise<any> {
    const loc = this.loc(args);
    const c = this.client();
    switch (toolName) {
      // Reads
      case 'get_affiliate_overview':
        return c.request('GET', `/${loc}/init`);
      case 'get_affiliate_campaigns':
        return c.request('GET', `/${loc}/campaigns`);
      case 'get_affiliate_campaign':
        return c.request('GET', `/${loc}/campaigns/${args.campaignId}`);
      case 'get_affiliates':
        return c.request('GET', `/${loc}/affiliates`);
      case 'get_affiliate':
      case 'get_affiliate_stats':
        return c.request('GET', `/${loc}/affiliates/${args.affiliateId}`);
      case 'get_payouts':
        return c.request('GET', `/${loc}/payouts`);
      case 'get_referrals':
        return c.request('GET', `/${loc}/transactions`);
      // Writes (affiliate roster)
      case 'create_affiliate': {
        const body: any = { affiliateEmail: args.email };
        if (args.firstName) body.affiliateFirstName = args.firstName;
        if (args.lastName) body.affiliateLastName = args.lastName;
        if (args.phone) body.affiliatePhone = args.phone;
        return c.request('POST', `/${loc}/affiliates`, body);
      }
      case 'delete_affiliate':
        return c.request('DELETE', `/${loc}/affiliates/${args.affiliateId}`);
      case 'delete_affiliate_campaign':
        return c.request('DELETE', `/${loc}/campaigns/${args.campaignId}`);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }
}
