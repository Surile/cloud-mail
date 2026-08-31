import orm from '../entity/orm';
import userPush from '../entity/user-push';
import settingService from './setting-service';
import { pushChannel, pushConfig, settingConst } from '../const/entity-const';
import KvConst from '../const/kv-const';
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
		// 推送场景没有 IPv6 直连需求，整类拒绝：一并封掉 ::ffff:127.0.0.1 等映射写法、
		// 0:0:...:1 完整写法与 2002::/6to4 编码，避免逐形态枚举漏网
		return true;
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

function buildBody(emailRow, includeCode) {
	const parts = [];
	if (emailRow.sendEmail) {
		parts.push(['From:', emailRow.name || emailRow.sendEmail].join(' '));
	}
	const text = emailUtils.formatText(emailRow.text) || emailUtils.htmlToText(emailRow.content);
	if (text) {
		parts.push(truncate(text, TEXT_LIMIT));
	}
	// 验证码属敏感内容：仅当用户显式开启"携带验证码"时才随通知出站
	if (includeCode && emailRow.code) {
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
			copyCode: row.copyCode,
			secretMasked: maskCredential(row.secret)
		};
	},

	// KV 滑窗计数：save/test 属"已登录用户可驱动的任意 URL 出站请求"，加上限防被当代理滥用
	async rateLimit(c, keyPrefix, max, ttlSeconds, userId) {
		const key = keyPrefix + userId;
		const count = Number(await c.env.kv.get(key)) || 0;
		if (count >= max) {
			throw new BizError(t('pushRateLimit'));
		}
		await c.env.kv.put(key, String(count + 1), { expirationTtl: ttlSeconds });
	},

	async save(c, userId, params) {

		await this.checkEnabled(c);
		await this.rateLimit(c, KvConst.USER_PUSH_SAVE, 10, 3600, userId);

		const channel = params.channel;
		const copyCode = Number(params.copyCode) === 1 ? 1 : 0;

		if (!Object.values(pushChannel).includes(channel)) {
			throw new BizError(t('pushInvalidChannel'));
		}

		const credential = (params.secret || '').trim();

		// 已配置过且本次未填凭证：只更新渠道/状态/验证码开关，保留原凭证（切换开关不必重填密钥）
		if (!credential) {
			const existing = await orm(c).select().from(userPush).where(eq(userPush.userId, userId)).get();
			if (!existing) {
				throw new BizError(t('pushMissingConfig'));
			}
			resolveUrl(channel, existing.secret);
			const status = Number(params.status) === pushConfig.DISABLE ? pushConfig.DISABLE : pushConfig.ENABLE;
			await orm(c).update(userPush).set({ channel, status, copyCode }).where(eq(userPush.userId, userId)).run();
			return;
		}

		if (channel === pushChannel.SERVERCHAN && !/^[A-Za-z0-9]+$/.test(credential)) {
			throw new BizError(t('pushInvalidFormat'));
		}

		// 落库前先校验，坏配置直接报错
		resolveUrl(channel, credential);

		const status = Number(params.status) === pushConfig.DISABLE ? pushConfig.DISABLE : pushConfig.ENABLE;

		await orm(c).insert(userPush)
			.values({ userId, channel, secret: credential, status, copyCode })
			.onConflictDoUpdate({
				target: userPush.userId,
				set: { channel, secret: credential, status, copyCode }
			}).run();
	},

	async remove(c, userId) {
		await orm(c).delete(userPush).where(eq(userPush.userId, userId)).run();
	},

	async sendTest(c, userId) {
		const setting = await querySetting(c);
		if (setting.userPushStatus !== settingConst.userPushStatus.OPEN) {
			throw new BizError(t('pushDisabled'));
		}
		await this.rateLimit(c, KvConst.USER_PUSH_TEST, 5, 600, userId);
		const row = await orm(c).select().from(userPush).where(eq(userPush.userId, userId)).get();
		if (!row) {
			throw new BizError(t('pushNotConfigured'));
		}
		// domainList 已解析并带 @ 前缀（env.domain 原始值是 JSON 字符串，直接下标会取到 '['）
		await this.deliver(row.channel, row.secret, {
			subject: t('pushTestTitle'),
			sendEmail: 'test' + (setting.domainList?.[0] || '@example.com'),
			text: t('pushTestBody'),
			code: ''
		}, row.copyCode);
	},

	async deliver(channel, credential, emailRow, copyCode) {
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
					code: copyCode ? emailRow.code : undefined,
					createTime: emailRow.createTime
				})
			};
		} else if (channel === pushChannel.SERVERCHAN) {
			init = {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ title, desp: buildBody(emailRow, copyCode) })
			};
		} else {
			const payload = { title, body: buildBody(emailRow, copyCode), group: 'cloud-mail' };
			// copy 字段点开即进剪贴板，验证码默认不出站
			if (copyCode && emailRow.code) {
				payload.copy = emailRow.code;
			}
			init = {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			};
		}

		// 不跟随重定向：用户把 webhook 指到 302 中转可绕过 host 校验；推送场景 3xx 本就不算成功
		const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });

		if (res.status >= 300 && res.status < 400) {
			throw new BizError([t('pushSendFail'), res.status].join(' '));
		}

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
			await this.deliver(row.channel, row.secret, emailRow, row.copyCode);
		} catch (e) {
			console.error(['用户推送失败:', e.message].join(' '));
		}
	}

};

export default userPushService;
