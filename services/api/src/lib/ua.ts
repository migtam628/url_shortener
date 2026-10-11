import { UAParser } from 'ua-parser-js';
import type { DeviceType } from '@mtlink/shared';

export interface ParsedUa {
  deviceType: DeviceType;
  os: string | null;
  browser: string | null;
  isBot: boolean;
}

/**
 * Bot detection by user-agent substring.
 *
 * This is a heuristic and it is meant to be: the goal is keeping obvious
 * crawler traffic out of the headline click number, not building a WAF.
 * Anything that evades this list also evades most commercial analytics.
 */
const BOT_PATTERNS = [
  'bot', 'crawler', 'spider', 'crawling', 'slurp', 'mediapartners',
  'facebookexternalhit', 'whatsapp', 'telegrambot', 'discordbot', 'slackbot',
  'twitterbot', 'linkedinbot', 'pinterest', 'redditbot', 'embedly', 'quora link preview',
  'curl/', 'wget/', 'python-requests', 'python-httpx', 'go-http-client', 'java/',
  'okhttp', 'axios/', 'node-fetch', 'got (', 'postmanruntime', 'insomnia',
  'headlesschrome', 'phantomjs', 'puppeteer', 'playwright', 'lighthouse',
  'uptimerobot', 'pingdom', 'statuscake', 'datadog', 'newrelic', 'site24x7',
  'ahrefsbot', 'semrushbot', 'mj12bot', 'dotbot', 'petalbot', 'bingpreview',
  'applebot', 'duckduckbot', 'yandex', 'baiduspider', 'gptbot', 'claudebot',
  'ccbot', 'perplexitybot', 'bytespider', 'amazonbot',
];

export function isBotUserAgent(ua: string | null | undefined): boolean {
  if (!ua) return true; // no UA at all is almost always automation
  const lower = ua.toLowerCase();
  return BOT_PATTERNS.some((p) => lower.includes(p));
}

export function parseUserAgent(ua: string | null | undefined): ParsedUa {
  if (!ua) {
    return { deviceType: 'unknown', os: null, browser: null, isBot: true };
  }

  const bot = isBotUserAgent(ua);
  const parsed = new UAParser(ua).getResult();

  let deviceType: DeviceType;
  if (bot) {
    deviceType = 'bot';
  } else {
    switch (parsed.device.type) {
      case 'mobile':
        deviceType = 'mobile';
        break;
      case 'tablet':
        deviceType = 'tablet';
        break;
      case undefined:
        // ua-parser leaves device.type unset for desktop browsers.
        deviceType = parsed.browser.name ? 'desktop' : 'unknown';
        break;
      default:
        deviceType = 'unknown';
    }
  }

  return {
    deviceType,
    os: parsed.os.name ?? null,
    browser: parsed.browser.name ?? null,
    isBot: bot,
  };
}

/** First language tag from an Accept-Language header, normalized. */
export function parseLanguage(header: string | null | undefined): string | null {
  if (!header) return null;
  const first = header.split(',')[0]?.split(';')[0]?.trim().toLowerCase();
  if (!first || first === '*') return null;
  return first.slice(0, 16);
}
