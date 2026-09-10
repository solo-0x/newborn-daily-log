import html from "../lib/newborn-html";
import { enhanceWithFeedReminder } from "../lib/feed-reminder";
export const dynamic="force-dynamic";
const enhancedHtml=enhanceWithFeedReminder(html);
export function GET(){return new Response(enhancedHtml,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","Content-Security-Policy":"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'"}})}
