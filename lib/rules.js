import rules from '../rules.json' with { type: 'json' };

export { rules };

export function teamMember(role) {
  const member = rules.team[role];
  if (!member) throw new Error(`rules.json has no team role "${role}"`);
  return member;
}
