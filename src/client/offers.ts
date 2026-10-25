// A barber offers a service only once someone has ticked it: no rule row means "not offered".
// (Mirror of isOffered/offers in src/server/domain.ts, kept separate so the client bundle stays small.)
type Rule = { staff_id: string; service_id: string; enabled: number };
export const offersService = (rules: Rule[], staffId: string, serviceId: string): boolean =>
  rules.some((r) => r.staff_id === staffId && r.service_id === serviceId && !!r.enabled);
