import orm from '../entity/orm';
import userPush from '../entity/user-push';
import settingService from './setting-service';
import { pushChannel, pushConfig, settingConst } from '../const/entity-const';
import { eq } from 'drizzle-orm';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';
import emailUtils from '../utils/email-utils';

const PUSH_TIMEOUT_MS = 8000;
const TEXT_LIMIT = 200;
const BARK_BASE = 'https://api.day.app/';
const SERVERCHAN_BASE = 'https://sctapi.ftqq.com/';

// 局部引用：settingService.query 内部不依赖 this，解构调用等价且免去 KV 缓存外的重复取值
const { query: querySetting } = settingService;

function truncate(text, limit) {
	if (!text) {
		return '';
	}
	return text.length > limit ? text.slice(0, limit) + '...' : text;
}

function maskCredential(credential) {
	if (!credential) {
		return '';
	}
	return credential.length <= 8 ? '****' : '****' + credential.slice(-4);
}

// 用户配置的地址会变成服务端出站请求：仅允许 http/https，并拒绝本地、环回、私有与保留地址
function isForbiddenHost(hostname) {
	const host = hostname.toLowerCase().replace(/\.$/, '');
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
		return true;
	}
	const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (ipv4) {
		const first = Number(ipv4[1]);
		const second = Number(ipv4[2]);
		if (first === 0 || first === 10 || first === 127) {
			return true;
		}
		if (first === 100 && second >= 64 && second <= 127) {
			return true;
		}
		if (first === 169 && second === 254) {
			return true;
		}
		if (first === 172 && second >= 16 && second <= 31) {
			return true;
		}
		if (first === 192 && second === 168) {
			return true;
		}
		return first >= 224;
	}
	if (host.includes(':')) {
		const ipv6 = host.replace(/^\[|\]$/g, '');
		return ipv6 === '::' || ipv6 === '::1' || ipv6.startsWith('fe8') || ipv6.startsWith('fc') || ipv6.startsWith('fd');
	}
	return false;
}

function assertSafeUrl(url) {
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new BizError(t('pushInvalidUrl'));
	}
	if (isForbiddenHost(url.hostname)) {
		throw new BizError(t('pushInvalidUrl'));
	}
}

function resolveUrl(channel, credential) {
	let url;
	try {
		if (channel === pushChannel.WEBHOOK) {
			url = new URL(credential);
		} else if (channel === pushChannel.BARK) {
			// 裸 device key 或自建完整地址均可
			url = new URL(credential, BARK_BASE);
		} else {
			url = new URL([credential, 'send'].join('.'), SERVERCHAN_BASE);
		}
	} catch (e) {
		throw new BizError(t('pushInvalidUrl'));
	}
	assertSafeUrl(url);
	return url;
}

function buildTitle(emailRow) {
	return truncate(emailRow.subject || t('pushNoSubject'), 64);
}

function buildBody(emailRow) {
	const parts = [];
	if (emailRow.sendEmail) {
		parts.push(['From:', emailRow.name || emailRow.sendEmail].join(' '));
	}
	const text = emailUtils.formatText(emailRow.text) || emailUtils.htmlToText(emailRow.content);
	if (text) {
		parts.push(truncate(text, TEXT_LIMIT));
	}
	if (emailRow.code) {
		parts.push([t('pushVerifyCode'), emailRow.code].join(': '));
	}
	return parts.join('\n');
}

const userPushService = {

	async checkEnabled(c) {
		const setting = await querySetting(c);
		if (setting.userPushStatus !== settingConst.userPushStatus.OPEN) {
			throw new BizError(t('pushDisabled'));
		}
	},

	async get(c, userId) {
		const row = await orm(c).select().from(userPush).where(eq(userPush.userId, userId)).get();
		if (!row) {
			return null;
		}
		return {
			channel: row.channel,
			status: row.status,
			secretMasked: maskCredential(row.secret)
		};
	},

	async save(c, userId, params) {

		await this.checkEnabled(c);

		const channel = params.channel;
		const credential = (params.secret || '').trim();

		if (!Object.values(pushChannel).includes(channel)) {
			throw new BizError(t('pushInvalidChannel'));
		}

		if (!credential) {
			throw new BizError(t('pushMissingConfig'));
		}

		if (channel === pushChannel.SERVERCHAN && !/^[A-Za-z0-9]+$/.test(credential)) {
			throw new BizError(t('pushInvalidFormat'));
		}

		// 落库前先校验，坏配置直接报错
		resolveUrl(channel, credential);

		const status = Number(params.status) === pushConfig.DISABLE ? pushConfig.DISABLE : pushConfig.ENABLE;

		await orm(c).insert(userPush)
			.values({ userId, channel, secret: credential, status })
			.onConflictDoUpdate({
				target: userPush.userId,
				set: { channel, secret: credential, status }
			}).run();
	},

	async remove(c, userId) {
		await orm(c).delete(userPush).where(eq(userPush.userId, userId)).run();
	},

	async sendTest(c, userId) {
		await this.checkEnabled(c);
		const row = await orm(c).select().from(userPush).where(eq(userPush.userId, userId)).get();
		if (!row) {
			throw new BizError(t('pushNotConfigured'));
		}
		await this.deliver(row.channel, row.secret, {
			subject: t('pushTestTitle'),
			sendEmail: 'test@' + (c.env.domain?.[0] || 'example.com'),
			text: t('pushTestBody'),
			code: ''
		});
	},

	async deliver(channel, credential, emailRow) {
		const url = resolveUrl(channel, credential);
		const title = buildTitle(emailRow);

		let init;
		if (channel === pushChannel.WEBHOOK) {
			init = {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					emailId: emailRow.emailId,
					toEmail: emailRow.toEmail,
					sendEmail: emailRow.sendEmail,
					name: emailRow.name,
					subject: emailRow.subject,
					text: emailRow.text,
					code: emailRow.code,
					createTime: emailRow.createTime
				})
			};
		} else if (channel === pushChannel.SERVERCHAN) {
			init = {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ title, desp: buildBody(emailRow) })
			};
		} else {
			const payload = { title, body: buildBody(emailRow), group: 'cloud-mail' };
			if (emailRow.code) {
				payload.copy = emailRow.code;
			}
			init = {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			};
		}

		const res = await fetch(url, { ...init, signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });

		if (!res.ok) {
			throw new BizError([t('pushSendFail'), res.status].join(' '));
		}
	},

	// 邮件进站时调用：只推收件人本人配置的渠道，任何异常都不影响收信
	async send(c, emailRow) {
		try {
			const setting = await querySetting(c);
			if (setting.userPushStatus !== settingConst.userPushStatus.OPEN) {
				return;
			}
			if (!emailRow.userId) {
				return;
			}
			const row = await orm(c).select().from(userPush).where(eq(userPush.userId, emailRow.userId)).get();
			if (!row || row.status !== pushConfig.ENABLE) {
				return;
			}
			await this.deliver(row.channel, row.secret, emailRow);
		} catch (e) {
			console.error(['用户推送失败:', e.message].join(' '));
		}
	}

};

export default userPushService;
