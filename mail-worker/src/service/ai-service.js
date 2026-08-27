import emailUtils from '../utils/email-utils';
import { settingConst } from '../const/entity-const';

const aiService = {
	async extractCode(c, email, options = {}) {
		if (!this.shouldExtractCode(options.aiCode, options.aiCodeFilter, email)) {
			return '';
		}

		const ai = c.env.ai;

		try {
			const subject = email.subject || '';
			const text = emailUtils.formatText(email.text || '');
			const htmlText = emailUtils.htmlToText(email.html || '');
			const body = (htmlText || text).slice(0, 6000);

			if (!subject && !body) {
				return '';
			}

			const result = await ai.run(c.env.ai_model || '@cf/meta/llama-3.1-8b-instruct-fast', {
				messages: [
					{
						role: 'system',
						content: 'You extract verification codes from emails. Return only JSON like {"code":"12345678"} or {"code":""}. The code must be 8 characters or fewer and must not contain spaces. If the code is longer than 8 characters or contains spaces, return {"code":""}. Do not explain.'
					},
					{
						role: 'user',
						content: `Subject: ${subject}\n\n${body}`
					}
				],
				temperature: 0,
				max_tokens: 32
			});

			const content = typeof result === 'string' ? result : result?.response || '';
			const json = typeof content === 'string' ? JSON.parse(content) : content;
			if (typeof json.code !== 'string') {
				return '';
			}

			if (json.code.length > 8 || /\s/.test(json.code)) {
				return '';
			}

			return json.code;
		} catch (e) {
			console.error('验证码提取失败: ', e);
			return '';
		}
	},

	shouldExtractCode(aiCode, aiCodeFilterStr, email) {
		if (aiCode !== settingConst.aiCode.OPEN) {
			return false;
		}

		const filterList = aiCodeFilterStr ? aiCodeFilterStr.split(',').map(item => item.trim().toLowerCase()).filter(Boolean) : [];

		if (filterList.length === 0) {
			return true;
		}

		const fromEmail = (email.from?.address || '').trim().toLowerCase();
		const fromDomain = emailUtils.getDomain(fromEmail).toLowerCase();

		return filterList.some(item => item === fromEmail || item === fromDomain);
	},

	// 申请单 AI 审核（Workers AI 通道）：一次调用同时判定前缀人格化与申请理由
	// 返回 { prefixOk, decision, reason }；无绑定/报错/解析失败返回 null
	async runWorkersAi(c, application) {

		if (!c.env.ai) {
			return null;
		}

		try {
			const result = await c.env.ai.run(c.env.ai_model || '@cf/meta/llama-3.1-8b-instruct-fast', {
				messages: [
					{
						role: 'system',
						content: 'You are the admissions reviewer of a community mailbox service (a parody university). Evaluate TWO things and respond with ONLY one JSON object: {"prefix_ok":true,"decision":"approve","reason":"short reason in the same language as the application reason"}. No markdown, no extra text.\n1) prefix_ok — does the desired email prefix look like something a real person would use as a personal address? OK examples: full pinyin name (wangxiaoming), given name, name plus initials (yxwang2001), western name (john.smith). NOT ok: gibberish, digit strings, brand/meme/celebrity names, offensive or敏感 words.\n2) decision — judge the application reason: approve if it describes a plausible legitimate personal use (community membership, website registrations, daily mail); reject if gibberish, copy-pasted filler, spam, abusive, illegal or bad-faith; review when unsure. Leniency scales with trust level: trust 2 — be lenient when prefix_ok and the reason is plausible; trust 1 — moderate; trust 0 — strict, prefer review when unsure.\nIf Fast lane is true, ignore the reason completely: only set prefix_ok, and set decision to "approve".'
					},
					{
						role: 'user',
						content: ['Fast lane: ' + (application.fastLane ? 'true' : 'false'), 'Prefix: ' + (application.prefix || ''), 'Platform: ' + (application.platform || ''), 'Username: ' + (application.username || ''), 'Trust level: ' + (application.trustLevel ?? 'unknown'), 'Reason: ' + (application.reason || '')].join('\n')
					}
				],
				temperature: 0,
				max_tokens: 220
			});

			const content = typeof result === 'string' ? result : result?.response || '';

			return this.parseVerdict(content);
		} catch (e) {
			console.error('Workers AI 审核失败: ', e.message);
			return null;
		}
	},

	// 统一入口：优先 Workers AI，不可用时回落智谱免费模型（需在系统设置配置 zhipuApiKey，模型 zhipuModel 可配）；全部不可用返回 null（调用方回落人工队列）
	async reviewApplication(c, application, zhipu) {

		const verdict = await this.runWorkersAi(c, application);

		if (verdict) {
			return verdict;
		}

		const key = String((zhipu && zhipu.key) || '').trim();

		if (!key) {
			return null;
		}

		try {
			const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': 'Bearer ' + key
				},
				body: JSON.stringify({
					model: (zhipu && zhipu.model) || 'glm-4.7-flash',
					messages: this.reviewMessages(application),
					temperature: 0,
					max_tokens: 220,
					stream: false,
					thinking: { type: 'disabled' }
				})
			});

			if (!res.ok) {
				console.error('智谱审核请求失败 status: ' + res.status);
				return null;
			}

			const data = await res.json();

			return this.parseVerdict(data?.choices?.[0]?.message?.content || '');
		} catch (e) {
			console.error('智谱 AI 审核失败: ', e.message);
			return null;
		}
	},

	reviewMessages(application) {
		return [
			{
				role: 'system',
				content: 'You are the admissions reviewer of a community mailbox service (a parody university). Evaluate TWO things and respond with ONLY one JSON object: {"prefix_ok":true,"decision":"approve","reason":"short reason in the same language as the application reason"}. No markdown, no extra text.\n1) prefix_ok — does the desired email prefix look like something a real person would use as a personal address? OK examples: full pinyin name (wangxiaoming), given name, name plus initials (yxwang2001), western name (john.smith). NOT ok: gibberish, digit strings, brand/meme/celebrity names, offensive words.\n2) decision — judge the application reason: approve if it describes a plausible legitimate personal use (community membership, website registrations, daily mail); reject if gibberish, copy-pasted filler, spam, abusive, illegal or bad-faith; review when unsure. Leniency scales with trust level: trust 2 — be lenient when prefix_ok and the reason is plausible; trust 1 — moderate; trust 0 — strict, prefer review when unsure.\nIf Fast lane is true, ignore the reason completely: only set prefix_ok, and set decision to "approve".'
			},
			{
				role: 'user',
				content: ['Fast lane: ' + (application.fastLane ? 'true' : 'false'), 'Prefix: ' + (application.prefix || ''), 'Platform: ' + (application.platform || ''), 'Username: ' + (application.username || ''), 'Trust level: ' + (application.trustLevel ?? 'unknown'), 'Reason: ' + (application.reason || '')].join('\n')
			}
		];
	},

	parseVerdict(content) {
		const match = String(content || '').replace(/```/g, '').match(/\{[\s\S]*\}/);

		if (!match) {
			return null;
		}

		try {
			const json = JSON.parse(match[0]);
			const decision = String(json.decision || '').toLowerCase();

			if (!['approve', 'reject', 'review'].includes(decision)) {
				return null;
			}

			return {
				prefixOk: json.prefix_ok === true,
				decision: decision,
				reason: String(json.reason || '').slice(0, 150)
			};
		} catch (e) {
			return null;
		}
	},

	// 拉取智谱可用模型列表（管理端下拉用）；无 Key 或失败返回空数组
	async listZhipuModels(c, zhipu) {
		const key = String((zhipu && zhipu.key) || '').trim();

		if (!key) {
			return [];
		}

		try {
			const res = await fetch('https://open.bigmodel.cn/api/paas/v4/models', {
				headers: {
					'Authorization': 'Bearer ' + key
				}
			});

			if (!res.ok) {
				console.error('获取智谱模型列表失败 status: ' + res.status);
				return [];
			}

			const data = await res.json();

			return (data?.data || []).map(m => ({ id: m.id || m.model || '', owned_by: m.owned_by || '' })).filter(m => m.id);
		} catch (e) {
			console.error('获取智谱模型列表失败: ', e.message);
			return [];
		}
	}
};

export default aiService;
