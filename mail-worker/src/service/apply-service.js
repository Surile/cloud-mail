import orm from '../entity/orm';
import apply from '../entity/apply';
import settingEntity from '../entity/setting';
import { oauth } from '../entity/oauth';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';
import jwtUtils from '../utils/jwt-utils';
import verifyUtils from '../utils/verify-utils';
import emailUtils from '../utils/email-utils';
import userService from './user-service';
import roleService from './role-service';
import accountService from './account-service';
import loginService from './login-service';
import regKeyService from './reg-key-service';
import aiService from './ai-service';
import saltHashUtils from '../utils/crypto-utils';
import { applyConst, isDel, settingConst } from '../const/entity-const';
import KvConst from '../const/kv-const';
import { and, asc, desc, eq, count, like, or, sql } from 'drizzle-orm';
import dayjs from 'dayjs';

const REASON_MIN_LENGTH = 10;
const APPLY_JWT_EXPIRE = 7 * 24 * 60 * 60;

const applyService = {

	generateApplyToken(c, oauthUserId) {
		return jwtUtils.generateToken(c, { type: 'apply', oauthUserId }, APPLY_JWT_EXPIRE);
	},

	async getSettingRow(c) {
		return await orm(c).select().from(settingEntity).get();
	},

	async verifyApplyToken(c, token) {

		if (!token) {
			throw new BizError(t('applyIdentityFail'), 401);
		}

		const payload = await jwtUtils.verifyToken(c, token);

		if (!payload || payload.type !== 'apply' || !payload.oauthUserId) {
			throw new BizError(t('applyIdentityFail'), 401);
		}

		const oauthRow = await orm(c).select().from(oauth).where(eq(oauth.oauthUserId, payload.oauthUserId)).get();

		if (!oauthRow) {
			throw new BizError(t('applyIdentityFail'), 401);
		}

		return { payload, oauthRow };
	},

	async submit(c, params) {

		const email = params.email;
		const reasonText = String(params.reason || '').trim();

		const verified = await this.verifyApplyToken(c, params.token);
		const oauthRow = verified.oauthRow;

		if (oauthRow.userId !== 0) {
			throw new BizError(t('oauthBound'));
		}

		const intakeSettingRow = await this.getSettingRow(c);

		// 入口总开关：关闭时拒收新申请（已提交的不受影响）
		if (!Number(intakeSettingRow.applyIntakeOpen)) {
			throw new BizError(t('applyEntryClosed'));
		}

		if (!verifyUtils.isEmail(email)) {
			throw new BizError(t('notEmail'));
		}

		const domainList = Array.isArray(c.env.domain) ? c.env.domain : JSON.parse(c.env.domain);

		if (!domainList.includes(emailUtils.getDomain(email))) {
			throw new BizError(t('notEmailDomain'));
		}

		const settingRow = await this.getSettingRow(c);
		const prefixFilters = String(settingRow.emailPrefixFilter || '').split(',').filter(Boolean);

		if (emailUtils.getName(email).length < settingRow.minEmailPrefix) {
			throw new BizError(t('applyMinPrefix'));
		}

		const bannedHit = prefixFilters.some(content => emailUtils.getName(email).includes(content));
		if (bannedHit) {
			throw new BizError(t('banEmailPrefix'));
		}

		if (reasonText.length < REASON_MIN_LENGTH) {
			throw new BizError(t('reasonTooShort'));
		}

		const pendingRow = await orm(c).select().from(apply)
			.where(and(eq(apply.oauthUserId, oauthRow.oauthUserId), eq(apply.status, applyConst.status.PENDING)))
			.get();

		if (pendingRow) {
			throw new BizError(t('applyExists'));
		}

		const accountRow = await accountService.selectByEmailIncludeDel(c, email);

		if (accountRow && accountRow.isDel === isDel.DELETE) {
			throw new BizError(t('isDelUser'));
		}
		if (accountRow) {
			throw new BizError(t('isRegAccount'));
		}

		// 选填注册码：有效则免审开通并继承码绑定的角色；无效直接报错，可去掉码后重新提交
		let regCodeInfo = null;
		const regCode = String(params.code || '').trim();

		if (regCode) {
			regCodeInfo = await loginService.handleOpenRegKey(c, settingConst.regKey.OPEN, regCode);
		}

		const applyRow = await orm(c).insert(apply).values({
			oauthUserId: oauthRow.oauthUserId,
			platform: oauthRow.platform,
			username: oauthRow.username,
			name: oauthRow.name,
			avatar: oauthRow.avatar,
			trustLevel: oauthRow.trustLevel,
			email: email,
			reason: reasonText,
			status: applyConst.status.PENDING,
			regCode: regCode,
			regRoleId: regCodeInfo ? regCodeInfo.type : 0
		}).returning().get();

		// 兼容尚未重跑 /api/init 的实例：设置缓存里还没有该字段时按默认 3 处理
		const threshold = settingRow.applyAutoTrustLevel == null ? 3 : (Number(settingRow.applyAutoTrustLevel) || 0);
		const trustLevel = Number(oauthRow.trustLevel === null ? -1 : oauthRow.trustLevel);
		const useAi = Number(settingRow.applyAiReview) === 1;
		const fastLane = regCodeInfo || (threshold > 0 && trustLevel >= threshold);

		// AI 开启时，免审通道也要先过"前缀像正常人名"这一关；AI 关闭则维持原直接放行
		if (fastLane && !useAi) {
			await this.approveWithFallback(c, applyRow, 'auto');
			return;
		}

		let verdict = null;

		if (useAi) {

			verdict = await aiService.reviewApplication(c, {
				fastLane: fastLane,
				prefix: emailUtils.getName(email),
				platform: oauthRow.platform,
				username: oauthRow.username,
				trustLevel: oauthRow.trustLevel,
				reason: reasonText
			}, { key: settingRow.zhipuApiKey, model: settingRow.zhipuModel, baseUrl: settingRow.zhipuBaseUrl });

			// 前缀审核不通过：任何人（含免审通道）直接驳回
			if (verdict && !verdict.prefixOk) {
				await this.rejectByAi(c, applyRow, verdict.reason);
				await this.notify(c, applyRow, 'ai-rejected');
				return;
			}

			// 免审通道：前缀过关即成功，不看理由
			if (verdict && fastLane) {
				await this.approveWithFallback(c, applyRow, 'auto');
				return;
			}

			if (verdict?.decision === 'approve') {
				await this.approveWithFallback(c, applyRow, 'ai-approved');
				return;
			}

			if (verdict?.decision === 'reject') {
				await this.rejectByAi(c, applyRow, verdict.reason);
				await this.notify(c, applyRow, 'ai-rejected');
				return;
			}

			// verdict 为空（AI 不可用/解析失败）或 review：转人工队列
		}

		await this.notify(c, applyRow, 'pending');
	},

	// 返回 true=开通成功；false=失败回落（留待审或作废）
	async approveWithFallback(c, applyRow, mode, silent) {
		try {
			await this.doApprove(c, applyRow, 0);
			if (!silent) {
				await this.notify(c, applyRow, mode);
			}
			return true;
		} catch (e) {
			// 身份已绑定邮箱（重复单/审批期间已自行登录绑定）：申请作废，避免永久卡在待审队列
			const voided = e.message === t('oauthBound');
			applyRow.remark = (e.message || 'unknown').slice(0, 200);
			await orm(c).update(apply).set({
				status: voided ? applyConst.status.REJECTED : applyConst.status.PENDING,
				remark: applyRow.remark,
				updateTime: dayjs().format('YYYY-MM-DD HH:mm:ss')
			}).where(eq(apply.applyId, applyRow.applyId)).run();
			if (!silent) {
				await this.notify(c, applyRow, 'fallback');
			}
			return false;
		}
	},

	async rejectByAi(c, applyRow, reason) {
		applyRow.remark = '[AI] ' + reason;
		await orm(c).update(apply).set({
			status: applyConst.status.REJECTED,
			remark: applyRow.remark,
			updateTime: dayjs().format('YYYY-MM-DD HH:mm:ss')
		}).where(eq(apply.applyId, applyRow.applyId)).run();
	},

	async mine(c, params) {

		const verified = await this.verifyApplyToken(c, params.token);

		const row = await orm(c).select().from(apply)
			.where(eq(apply.oauthUserId, verified.oauthRow.oauthUserId))
			.orderBy(desc(apply.applyId))
			.limit(1)
			.get();

		if (!row) {
			return {};
		}

		const result = {
			email: row.email,
			status: row.status,
			remark: row.remark,
			createTime: row.createTime
		};

		// 待审单附带审核进度：按“信任等级降序 + 同级先提交在前”的优先级计算排队位次
		if (row.status === applyConst.status.PENDING) {

			const mineTl = row.trustLevel === null ? -1 : row.trustLevel;

			const totalRow = await orm(c).select({ total: count() }).from(apply)
				.where(eq(apply.status, applyConst.status.PENDING)).get();

			const aheadRow = await orm(c).select({ c: count() }).from(apply).where(and(
				eq(apply.status, applyConst.status.PENDING),
				sql`(CASE WHEN ${apply.trustLevel} IS NULL THEN -1 ELSE ${apply.trustLevel} END > ${mineTl}
				     OR (${apply.trustLevel} = ${mineTl} AND ${apply.applyId} < ${row.applyId}))`
			)).get();

			result.queue = aheadRow.c + 1;
			result.total = totalRow.total;
		}

		return result;
	},

	async list(c, params) {

		let num = Number(params.num) || 1;
		let size = Number(params.size) || 15;

		if (size > 50) {
			size = 50;
		}

		num = (num - 1) * size;

		const conditions = [];

		if (params.status !== undefined && params.status !== '') {
			conditions.push(eq(apply.status, Number(params.status)));
		}

		if (params.keyword) {
			const kw = '%' + params.keyword + '%';
			conditions.push(or(
				like(apply.username, kw),
				like(apply.name, kw),
				like(apply.email, kw)
			));
		}

		const where = and(...conditions);

		const listQuery = orm(c).select().from(apply)
			.where(where)
			.orderBy(
				sql`CASE WHEN ${apply.status} = 0 THEN 0 ELSE 1 END`,
				sql`CASE WHEN ${apply.trustLevel} IS NULL THEN -1 ELSE ${apply.trustLevel} END DESC`,
				desc(apply.applyId)
			)
			.limit(size)
			.offset(num);

		const totalQuery = orm(c).select({ total: count() }).from(apply).where(where);

		const rows = await Promise.all([listQuery.all(), totalQuery.get()]);

		return { list: rows[0], total: rows[1].total };
	},

	async approve(c, params, adminId) {

		const applyRow = await orm(c).select().from(apply).where(eq(apply.applyId, Number(params.applyId))).get();

		if (!applyRow) {
			throw new BizError(t('applyNotFound'));
		}

		await this.doApprove(c, applyRow, adminId);
		await this.notify(c, applyRow, 'approved');
	},

	async doApprove(c, applyRow, adminId) {

		if (!applyRow || applyRow.status !== applyConst.status.PENDING) {
			throw new BizError(t('applyProcessed'));
		}

		let oauthRow = await orm(c).select().from(oauth).where(eq(oauth.oauthUserId, applyRow.oauthUserId)).get();

		if (!oauthRow) {
			oauthRow = await orm(c).insert(oauth).values({
				oauthUserId: applyRow.oauthUserId,
				platform: applyRow.platform,
				username: applyRow.username,
				name: applyRow.name,
				avatar: applyRow.avatar,
				trustLevel: applyRow.trustLevel,
				userId: 0
			}).returning().get();
		}

		if (oauthRow.userId !== 0) {
			throw new BizError(t('oauthBound'));
		}

		const accountRow = await accountService.selectByEmailIncludeDel(c, applyRow.email);

		if (accountRow && accountRow.isDel === isDel.DELETE) {
			throw new BizError(t('isDelUser'));
		}
		if (accountRow) {
			throw new BizError(t('isRegAccount'));
		}

		let roleId = null;

		if (applyRow.regRoleId) {
			const codeRole = await roleService.selectById(c, applyRow.regRoleId);
			if (codeRole) {
				roleId = applyRow.regRoleId;
			}
		}

		if (!roleId) {
			const defRole = await roleService.selectDefaultRole(c);
			roleId = defRole.roleId;
		}

		let regKeyId = 0;

		if (applyRow.regCode) {
			const codeRow = await regKeyService.selectByCode(c, applyRow.regCode);
			if (codeRow) {
				regKeyId = codeRow.regKeyId;
				await regKeyService.reduceCount(c, applyRow.regCode, 1);
			}
		}

		await userService.add(c, {
			email: applyRow.email,
			password: saltHashUtils.genRandomPwd(),
			type: roleId,
			regKeyId: regKeyId
		});

		const userRow = await userService.selectByEmail(c, applyRow.email);

		// 条件更新：仅当身份仍处于未绑定时才落绑定。若审批期间身份已被并发绑定到其他账号，
		// 更新未命中时刚建的号是无主孤儿，物理删除并作废申请，绝不覆盖既有绑定
		const bindRes = await orm(c).update(oauth).set({ userId: userRow.userId })
			.where(and(eq(oauth.oauthId, oauthRow.oauthId), eq(oauth.userId, 0))).run();

		if (!bindRes?.meta?.changes) {
			await userService.physicsDelete(c, { userIds: String(userRow.userId) });
			throw new BizError(t('oauthBound'));
		}

		await orm(c).update(apply).set({
			status: applyConst.status.APPROVED,
			adminId: adminId,
			updateTime: dayjs().format('YYYY-MM-DD HH:mm:ss')
		}).where(eq(apply.applyId, applyRow.applyId)).run();
	},

	async reject(c, params, adminId) {

		const applyRow = await orm(c).select().from(apply).where(eq(apply.applyId, Number(params.applyId))).get();

		if (!applyRow) {
			throw new BizError(t('applyNotFound'));
		}

		if (applyRow.status !== applyConst.status.PENDING) {
			throw new BizError(t('applyProcessed'));
		}

		const remark = String(params.remark || '').trim().slice(0, 200);

		await orm(c).update(apply).set({
			status: applyConst.status.REJECTED,
			remark: remark,
			adminId: adminId,
			updateTime: dayjs().format('YYYY-MM-DD HH:mm:ss')
		}).where(eq(apply.applyId, applyRow.applyId)).run();
	},

	// 批量人工操作：逐条走完整的开通/驳回链路，单条失败不影响其他，返回失败明细
	async batchApprove(c, params, adminId) {
		return await this.runBatch(c, params.applyIds, adminId, 'approve', params.remark);
	},

	async batchReject(c, params, adminId) {
		return await this.runBatch(c, params.applyIds, adminId, 'reject', params.remark);
	},

	async runBatch(c, applyIds, adminId, action, remark) {

		const ids = (Array.isArray(applyIds) ? applyIds : []).map(Number).filter(Boolean).slice(0, 100);
		const okIds = [];
		const failed = [];

		for (const applyId of ids) {

			try {
				const applyRow = await orm(c).select().from(apply).where(eq(apply.applyId, applyId)).get();

				if (!applyRow) {
					throw new BizError(t('applyNotFound'));
				}

				if (applyRow.status !== applyConst.status.PENDING) {
					throw new BizError(t('applyProcessed'));
				}

				if (action === 'approve') {
					await this.doApprove(c, applyRow, adminId);
				} else {
					const clean = String(remark || '').trim().slice(0, 200);
					await orm(c).update(apply).set({
						status: applyConst.status.REJECTED,
						remark: clean,
						adminId: adminId,
						updateTime: dayjs().format('YYYY-MM-DD HH:mm:ss')
					}).where(eq(apply.applyId, applyRow.applyId)).run();
				}

				okIds.push(applyId);
			} catch (e) {
				failed.push({ applyId: applyId, message: e.message });
			}
		}

		return { ok: okIds.length, okIds: okIds, failed: failed };
	},

	async notify(c, applyRow, mode) {

		if (!applyRow) {
			return;
		}

		try {
			const settingRow = await this.getSettingRow(c);
			const token = settingRow.tgBotToken;
			const rawChatId = settingRow.tgChatId;

			if (!token || !rawChatId || Number(settingRow.tgBotStatus) === settingConst.tgBotStatus.CLOSE) {
				return;
			}

			const trustText = applyRow.trustLevel === null ? 'unknown' : ['TL', applyRow.trustLevel].join('');
			const who = [applyRow.username, applyRow.platform, trustText].filter(Boolean).join(' ');
			const headMap = {
				auto: '邮箱申请已自动通过',
				fallback: '邮箱申请自动通过失败，转人工审核',
				pending: '收到新的邮箱申请（待人工审核）',
				approved: '邮箱申请已人工通过',
				'ai-approved': 'AI 审核通过，已自动开通',
				'ai-rejected': 'AI 审核驳回（可在后台复核）'
			};
			const reasonPart = (mode === 'fallback' || mode === 'ai-rejected') ? ['原因：', applyRow.remark].join('') : '';
			const lines = [
				headMap[mode] || '邮箱申请状态更新',
				['申请人：', who].join(''),
				['期望地址：', applyRow.email].join(''),
				reasonPart
			];

			const apiBase = ['https://api.telegram.org/bot', token, '/sendMessage'].join('');

			const chatIds = String(rawChatId).split(',').map(item => item.trim()).filter(Boolean);

			for (const chatId of chatIds) {
				await fetch(apiBase, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						chat_id: chatId,
						text: lines.filter(Boolean).join('\n')
					})
				});
			}
		} catch (e) {
			console.error('Telegram notify failed:', e.message);
		}
	}

};

export default applyService
