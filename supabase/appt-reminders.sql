-- Day-before appointment confirmation texts to customers (run once in Supabase → SQL Editor).
-- Every afternoon at 5 PM Dallas time, each customer with an appointment tomorrow gets:
--   "Hi Rachel, Nation's Pure confirming your appointment tomorrow, Fri Nov 13 at 10:30 AM with Dylen.
--    To cancel or reschedule, call 817-238-0050."
-- Sent by the send-texts edge function (action "reminders"); see supabase/functions/send-texts/index.ts.
alter table public.leads add column if not exists reminder_sent_for text not null default '';
-- the edge function reads tomorrow's appointments and marks each one sent
grant select on public.leads to service_role;
grant update (reminder_sent_for) on public.leads to service_role;
notify pgrst, 'reload schema';
create extension if not exists pg_cron;

create or replace function public.send_appt_reminders(p_body jsonb default '{"action":"reminders"}'::jsonb)
returns bigint language plpgsql security definer set search_path = public as $fn$
declare secret text;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'texts_webhook_secret';
  return net.http_post(
    url := 'https://sesfqybelitpgfuhsbmy.supabase.co/functions/v1/send-texts',
    headers := jsonb_build_object('Content-Type','application/json','x-webhook-secret', coalesce(secret,'')),
    body := p_body,
    timeout_milliseconds := 30000);
end $fn$;
revoke all on function public.send_appt_reminders(jsonb) from public, anon, authenticated;

-- runs at 22:00 and 23:00 UTC; the function only sends during the 5 PM hour in Dallas, so DST doesn't matter
select cron.schedule('appt-reminders', '0 22,23 * * *', $job$select public.send_appt_reminders()$job$);

-- Preview tomorrow's texts without sending anything:
--   select public.send_appt_reminders('{"action":"reminders","force":true,"dry":true}'::jsonb);
--   select status_code, content from net._http_response order by id desc limit 1;
