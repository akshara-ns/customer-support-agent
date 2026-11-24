/** Mock CRM built from data/mock_users.json, with dates resolved relative to `now`. */
import raw from "@/data/mock_users.json";
import type { CustomerDirectory } from "@/lib/tools/stores";
import type { CustomerRecord } from "@/lib/tools/types";
import type { ContractStatus, Tier } from "@/lib/types";

interface RawUser {
  customer_id: string;
  name: string;
  email: string;
  support_pin: string;
  tier: string;
  contract_status: string;
  contract_end_in_days: number | null;
  invoices: { invoice_id: string; days_ago: number; amount_usd: number; description: string; refunded_usd: number; chargeback: boolean }[];
}

const isoDay = (now: Date, offsetDays: number) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

export function loadCustomers(now: Date): CustomerRecord[] {
  return (raw.users as RawUser[]).map((u) => ({
    customerId: u.customer_id,
    name: u.name,
    email: u.email.toLowerCase(),
    supportPin: u.support_pin,
    tier: u.tier as Tier,
    contractStatus: u.contract_status as ContractStatus,
    contractEnd: u.contract_end_in_days === null ? null : isoDay(now, u.contract_end_in_days),
    invoices: u.invoices.map((i) => ({
      invoiceId: i.invoice_id,
      date: isoDay(now, -i.days_ago),
      amountUsd: i.amount_usd,
      description: i.description,
      refundedUsd: i.refunded_usd,
      chargeback: i.chargeback,
    })),
  }));
}

export function customerDirectory(now: Date): CustomerDirectory {
  const users = loadCustomers(now);
  return {
    findByEmail: (email) => users.find((u) => u.email === email.trim().toLowerCase()),
    get: (id) => users.find((u) => u.customerId === id),
  };
}

/** Public demo panel data (fake accounts; PINs are shown on purpose so reviewers can try it). */
export interface DemoUser {
  name: string;
  email: string;
  pin: string;
  tier: Tier;
  contractStatus: ContractStatus;
  tryThis: string;
}

const TRY_THIS: Record<string, string> = {
  cus_free_maya: "Refund the $12 Storage Pack (inv_1001 or inv_1002) or the $9 template bundle",
  cus_pro_omar: "Refund a seat add-on ($29 inv_2004, $58 inv_2005) or the duplicate inv_2002; $900 of annual inv_2003 is over the limit",
  cus_ent_northbeam: "Refund $650 (inv_3001), $420 (inv_3003) or $880 (inv_3004); $1,500 inv_3005 is over the limit",
  cus_pro_expired_leo: "Refund a charge billed after the contract ended (inv_4001, inv_4002)",
  cus_pro_suspended_ana: "Ask for any refund on a suspended account",
  cus_pro_refunded_sam: "Refund inv_6001 (already refunded) or inv_6002 / inv_6003",
};

export function demoUsers(): DemoUser[] {
  return (raw.users as RawUser[]).map((u) => ({
    name: u.name,
    email: u.email,
    pin: u.support_pin,
    tier: u.tier as Tier,
    contractStatus: u.contract_status as ContractStatus,
    tryThis: TRY_THIS[u.customer_id] ?? "",
  }));
}
