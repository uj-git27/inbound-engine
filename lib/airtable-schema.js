import { rules } from './rules.js';

const text = (name) => ({ name, type: 'singleLineText' });
const long = (name) => ({ name, type: 'multilineText' });
const number = (name) => ({ name, type: 'number', options: { precision: 0 } });
const check = (name) => ({ name, type: 'checkbox', options: { icon: 'check', color: 'greenBright' } });
const time = (name) => ({
  name,
  type: 'dateTime',
  options: { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'utc' },
});

// The first field of each table is its primary field.
export const tableDefinitions = [
  {
    name: rules.tables.leads,
    description: 'Log and review queue: one row per demo request.',
    fields: [
      text('lead_id'), text('status'), time('received_at'),
      text('name'), text('email'), text('title'), text('company'), text('website'), text('domain'),
      text('first_choice'), text('backup_choice'), text('time_zone'), check('demo'),
      text('decision'), long('reason'), text('tier'), number('score'), text('route'), text('owner'), long('flags'),
      number('paid_calls'), long('paid_calls_detail'), text('slot'), text('event_link'),
      long('brief'), long('drafts'), long('evidence_json'), long('notes'), long('timeline'),
      text('rep_verdict'), long('reviewer_actions'), long('error'),
      text('linkedin'), text('person_title'), text('role_start'), long('previous_companies'), text('person_source'),
      text('phone'), text('phone_source'),
      text('event_id'), long('emails_log'), long('state_json'),
      long('raw_payload'), long('clay_payload'),
    ],
  },
  {
    name: rules.tables.cache,
    description: 'Paid results cached by domain or email.',
    fields: [text('key'), text('kind'), long('value'), text('source'), time('stored_at')],
  },
  {
    name: rules.tables.crm,
    description: 'Fallback CRM (CRM_PROVIDER=airtable): one row per company domain.',
    fields: [
      text('domain'), text('name'), text('lifecyclestage'), text('deal_name'), text('deal_stage'), text('owner'),
      text('lost_reason'), text('last_touch'),
      number('headcount'), text('country'), text('industry'), text('funding_stage'), time('enriched_at'),
      text('parent_domain'), number('score'), text('tier'), long('reasons'), long('signal_links'),
      check('nurture'), text('rep_verdict'),
      text('contact_name'), text('contact_email'), text('contact_title'),
      check('test_record'), long('notes'),
    ],
  },
];
