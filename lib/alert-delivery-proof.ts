export function verifiedSubscriberDeliverySql(alias = "a"): string {
  return `EXISTS (
  SELECT 1
  FROM options_alerts oa
  INNER JOIN options_paper_trades opt
    ON opt.alert_id = oa.alert_id
   AND opt.paper_kind = 'DELIVERED_ALERT_PAPER'
   AND opt.option_symbol = oa.option_symbol
  WHERE oa.state = 'SENT'
    AND COALESCE(oa.research_only, 0) = 0
    AND oa.paper_linked = 1
    AND oa.discord_message_id IS NOT NULL
    AND oa.discord_message_id <> ''
    AND oa.opportunity_case_id IS NOT NULL
    AND oa.opportunity_case_id <> ''
    AND oa.entry_mid IS NOT NULL
    AND oa.entry_mid > 0
    AND oa.option_symbol = ${alias}.option_symbol
    AND UPPER(oa.candidate_symbol) = UPPER(${alias}.ticker)
    AND LOWER(oa.side) = LOWER(${alias}.option_side)
    AND ABS(COALESCE(oa.sent_at_ms, oa.created_at_ms) - CAST(strftime('%s', ${alias}.alert_time) AS INTEGER) * 1000) <= 30 * 60 * 1000
    AND EXISTS (
      SELECT 1 FROM options_snapshots s
      WHERE s.alert_id = ${alias}.id
        AND s.checkpoint = 'alert'
        AND s.option_symbol = ${alias}.option_symbol
        AND s.mid IS NOT NULL
        AND s.mid > 0
    )
    AND EXISTS (
      SELECT 1 FROM options_snapshots s
      WHERE s.alert_id = ${alias}.id
        AND s.checkpoint IN ('live','eod')
        AND s.option_symbol = ${alias}.option_symbol
        AND s.mid IS NOT NULL
        AND s.mid > 0
    )
)`;
}

function nearestSentOptionsAlertSql(selectExpr: string, alias = "a"): string {
  return `(SELECT ${selectExpr} FROM options_alerts oa
  WHERE oa.state='SENT' AND oa.option_symbol=${alias}.option_symbol AND UPPER(oa.candidate_symbol)=UPPER(${alias}.ticker)
    AND LOWER(oa.side)=LOWER(${alias}.option_side)
    AND ABS(COALESCE(oa.sent_at_ms, oa.created_at_ms) - CAST(strftime('%s', ${alias}.alert_time) AS INTEGER) * 1000) <= 30 * 60 * 1000
  ORDER BY COALESCE(oa.sent_at_ms, oa.created_at_ms) DESC
  LIMIT 1)`;
}

export function deliveryAlertIdSql(alias = "a"): string {
  return nearestSentOptionsAlertSql("oa.alert_id", alias);
}

export function deliveryDiscordMessageIdSql(alias = "a"): string {
  return nearestSentOptionsAlertSql("oa.discord_message_id", alias);
}

export function deliveryOpportunityCaseIdSql(alias = "a"): string {
  return nearestSentOptionsAlertSql("oa.opportunity_case_id", alias);
}

export function deliveryPaperTradeIdSql(alias = "a"): string {
  return `(SELECT opt.id FROM options_alerts oa
  INNER JOIN options_paper_trades opt ON opt.alert_id=oa.alert_id AND opt.paper_kind='DELIVERED_ALERT_PAPER' AND opt.option_symbol=oa.option_symbol
  WHERE oa.state='SENT' AND oa.option_symbol=${alias}.option_symbol AND UPPER(oa.candidate_symbol)=UPPER(${alias}.ticker)
    AND LOWER(oa.side)=LOWER(${alias}.option_side)
    AND ABS(COALESCE(oa.sent_at_ms, oa.created_at_ms) - CAST(strftime('%s', ${alias}.alert_time) AS INTEGER) * 1000) <= 30 * 60 * 1000
  ORDER BY COALESCE(oa.sent_at_ms, oa.created_at_ms) DESC
  LIMIT 1)`;
}
