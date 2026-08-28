import BizError from "../error/biz-error";
import orm from "../entity/orm";
import {oauth} from "../entity/oauth";
import applyEntity from "../entity/apply";
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import userService from "./user-service";
import loginService from "./login-service";
import cryptoUtils from "../utils/crypto-utils";
import settingEntity from "../entity/setting";
import applyService from "./apply-service";
import { applyConst } from '../const/entity-const';
import {t} from '../i18n/i18n';

const oauthService = {

	async bindUser(c, params) {

		const { email, oauthUserId, code } = params;

		const oauthRow = await this.getById(c, oauthUserId);

		let userRow = await userService.selectByIdIncludeDel(c, oauthRow.userId);

		if (userRow) {
			throw new BizError('用户已绑定有邮箱')
		}

		await loginService.register(c, { email, password: cryptoUtils.genRandomPwd(), code }, true);

		userRow = await userService.selectByEmail(c, email);

		orm(c).update(oauth).set({ userId: userRow.userId }).where(eq(oauth.oauthUserId, oauthUserId)).run();
		const jwtToken = await loginService.login(c, { email, password: null }, true);

		return { userInfo: oauthRow, token: jwtToken}
	},

	async fetchLinuxDoUser(c, code, redirectUri) {

		const setting = await orm(c).select().from(settingEntity).get();
		this.assertEnabled(setting, 'linuxdoSwitch');

		const reqParams = new URLSearchParams()
		reqParams.append('client_id', setting.linuxdoClientId)
		reqParams.append('client_secret', setting.linuxdoClientSecret)
		reqParams.append('code', code)
		reqParams.append('redirect_uri', redirectUri)
		reqParams.append('grant_type', 'authorization_code')

		const tokenRes = await fetch("https://connect.linux.do/oauth2/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: reqParams.toString()
		})

		if (!tokenRes.ok) {
			throw new BizError(tokenRes.statusText)
		}

		const token = await tokenRes.json()

		const userRes = await fetch('https://connect.linux.do/api/user', {
			headers: {
				Authorization: 'Bearer ' + token.access_token
			}
		});

		if (!userRes.ok) {
			throw new BizError(userRes.statusText)
		}

		const userInfo = await userRes.json();

		userInfo.oauthUserId = String(userInfo.id);
		userInfo.active = userInfo.active ? 0 : 1;
		userInfo.silenced = userInfo.silenced ? 0 : 1;
		userInfo.trustLevel = userInfo.trust_level;
		userInfo.avatar = userInfo.avatar_url;
		userInfo.platform = 'linuxdo';

		return userInfo
	},

	async linuxDoLogin(c, params) {
		const userInfo = await this.fetchLinuxDoUser(c, params.code, params.redirectUri);
		return await this.saveAndLogin(c, userInfo)
	},

	async fetchGithubUser(c, code, redirectUri) {

		const setting = await orm(c).select().from(settingEntity).get();
		this.assertEnabled(setting, 'githubSwitch');

		const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Accept": "application/json"
			},
			body: JSON.stringify({
				client_id: setting.githubClientId,
				client_secret: setting.githubClientSecret,
				code: code,
				redirect_uri: redirectUri
			})
		});

		if (!tokenRes.ok) {
			throw new BizError(tokenRes.statusText);
		}

		const token = await tokenRes.json();

		if (token.error) {
			throw new BizError(token.error_description || token.error);
		}

		const userRes = await fetch('https://api.github.com/user', {
			headers: {
				Authorization: 'Bearer ' + token.access_token,
				'User-Agent': 'cloud-mail'
			}
		});

		if (!userRes.ok) {
			throw new BizError(userRes.statusText);
		}

		const userInfo = await userRes.json();

		userInfo.oauthUserId = String(userInfo.id);
		userInfo.username = userInfo.login;
		userInfo.avatar = userInfo.avatar_url;
		userInfo.platform = 'github';

		return userInfo
	},

	async githubLogin(c, params) {
		const userInfo = await this.fetchGithubUser(c, params.code, params.redirectUri);
		return await this.saveAndLogin(c, userInfo);
	},

	async fetchGoogleUser(c, code, redirectUri) {

		const setting = await orm(c).select().from(settingEntity).get();
		this.assertEnabled(setting, 'googleSwitch');

		const reqParams = new URLSearchParams()
		reqParams.append('client_id', setting.googleClientId)
		reqParams.append('client_secret', setting.googleClientSecret)
		reqParams.append('code', code)
		reqParams.append('redirect_uri', redirectUri)
		reqParams.append('grant_type', 'authorization_code')

		const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: reqParams.toString()
		});

		if (!tokenRes.ok) {
			throw new BizError(tokenRes.statusText);
		}

		const token = await tokenRes.json();

		const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
			headers: {
				Authorization: 'Bearer ' + token.access_token
			}
		});

		if (!userRes.ok) {
			throw new BizError(userRes.statusText);
		}

		const userInfo = await userRes.json();

		userInfo.oauthUserId = String(userInfo.sub);
		userInfo.username = userInfo.email;
		userInfo.name = userInfo.name;
		userInfo.avatar = userInfo.picture;
		userInfo.platform = 'google';

		return userInfo
	},

	async googleLogin(c, params) {
		const userInfo = await this.fetchGoogleUser(c, params.code, params.redirectUri);
		return await this.saveAndLogin(c, userInfo);
	},

	async saveAndLogin(c, userInfo) {

		const oauthRow = await this.saveUser(c, userInfo);
		const userRow = await userService.selectByIdIncludeDel(c, oauthRow.userId);

		if (!userRow) {
			const applyJwt = await applyService.generateApplyToken(c, oauthRow.oauthUserId);
			return { userInfo: oauthRow, token: null, applyJwt: applyJwt };
		}

		const JwtToken = await loginService.login(c, { email: userRow.email, password: null }, true);
		return { userInfo: oauthRow, token: JwtToken };
	},

	// 登录与"追加绑定"共用的平台取用户流程（含该平台开关校验）
	async fetchPlatformUser(c, platform, code, redirectUri) {
		switch (platform) {
			case 'linuxdo':
				return await this.fetchLinuxDoUser(c, code, redirectUri);
			case 'github':
				return await this.fetchGithubUser(c, code, redirectUri);
			case 'google':
				return await this.fetchGoogleUser(c, code, redirectUri);
			default:
				throw new BizError(t('oauthDisabled'));
		}
	},

	// 软着陆：已登录用户把新的三方身份绑定到当前账号（bindUser 是"注册新邮箱+绑定"，覆盖不了存量账密用户）
	async bindIdentity(c, params, userId) {

		const { platform, code, redirectUri } = params;
		const userInfo = await this.fetchPlatformUser(c, platform, code, redirectUri);

		const existing = await this.getById(c, userInfo.oauthUserId);

		if (existing && existing.userId === userId) {
			throw new BizError(t('oauthBindDuplicate'));
		}

		if (existing && existing.userId !== 0) {
			throw new BizError(t('oauthBindOccupied'));
		}

		return await this.saveUser(c, { ...userInfo, userId });
	},

	async listByUserId(c, userId) {
		return await orm(c).select({
			oauthUserId: oauth.oauthUserId,
			platform: oauth.platform,
			username: oauth.username,
			name: oauth.name,
			avatar: oauth.avatar,
			createTime: oauth.createTime
		}).from(oauth).where(eq(oauth.userId, userId)).all();
	},

	// 解绑保护：至少保留一种登录方式，避免撤掉账密入口后该账号无门可进
	async unbind(c, params, userId) {

		const rows = await orm(c).select({ oid: oauth.oauthUserId }).from(oauth).where(eq(oauth.userId, userId)).all();

		if (!rows.some(row => String(row.oid) === String(params.oauthUserId))) {
			throw new BizError(t('oauthUnbindNotOwned'));
		}

		if (rows.length <= 1) {
			throw new BizError(t('oauthUnbindLastDenied'));
		}

		await orm(c).delete(oauth).where(and(eq(oauth.oauthUserId, params.oauthUserId), eq(oauth.userId, userId))).run();
	},

	async saveUser(c, userInfo) {

		const userInfoRow = await this.getById(c, userInfo.oauthUserId);

		if (!userInfoRow) {
			return await orm(c).insert(oauth).values(userInfo).returning().get();
		} else {
			return await orm(c).update(oauth).set(userInfo).where(eq(oauth.oauthUserId, userInfo.oauthUserId)).returning().get();
		}

	},

	assertEnabled(setting, switchKey) {
		if (setting[switchKey] !== 0) {
			throw new BizError(t('oauthDisabled'));
		}
	},

	async getById(c, oauthUserId) {
		return await orm(c).select().from(oauth).where(eq(oauth.oauthUserId, oauthUserId)).get();
	},

	async deleteByUserId(c, userId) {
		await this.deleteByUserIds(c, [userId]);
	},

	async deleteByUserIds(c, userIds) {
		await orm(c).delete(oauth).where(inArray(oauth.userId, userIds)).run();
	},

	//定时任务凌晨清除未绑定邮箱的oauth用户；保留仍存在待审申请的身份，避免申请人等待审核期间被误删
	async clearNoBindOathUser(c) {

		const pendingSubQuery = orm(c)
			.select({ oid: applyEntity.oauthUserId })
			.from(applyEntity)
			.where(eq(applyEntity.status, applyConst.status.PENDING));

		await orm(c).delete(oauth).where(and(
			eq(oauth.userId, 0),
			notInArray(oauth.oauthUserId, pendingSubQuery)
		)).run();
	},

}

export default  oauthService
