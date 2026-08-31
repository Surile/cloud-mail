import app from '../hono/hono';
import userService from '../service/user-service';
import oauthService from '../service/oauth-service';
import userPushService from '../service/user-push-service';
import result from '../model/result';
import userContext from '../security/user-context';

app.get('/my/loginUserInfo', async (c) => {
	const user = await userService.loginUserInfo(c, userContext.getUserId(c));
	return c.json(result.ok(user));
});

app.put('/my/resetPassword', async (c) => {
	await userService.resetPassword(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok());
});

app.delete('/my/delete', async (c) => {
	await userService.delete(c, userContext.getUserId(c));
	return c.json(result.ok());
});

app.get('/my/oauthBindings', async (c) => {
	const rows = await oauthService.listByUserId(c, userContext.getUserId(c));
	return c.json(result.ok(rows));
});

app.post('/my/oauthBind', async (c) => {
	await oauthService.bindIdentity(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok());
});

app.delete('/my/oauthUnbind', async (c) => {
	await oauthService.unbind(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok());
});

app.get('/my/push/get', async (c) => {
	const data = await userPushService.get(c, userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.post('/my/push/save', async (c) => {
	await userPushService.save(c, userContext.getUserId(c), await c.req.json());
	return c.json(result.ok());
});

app.delete('/my/push/delete', async (c) => {
	await userPushService.remove(c, userContext.getUserId(c));
	return c.json(result.ok());
});

app.post('/my/push/test', async (c) => {
	await userPushService.sendTest(c, userContext.getUserId(c));
	return c.json(result.ok());
});



