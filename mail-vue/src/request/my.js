import http from '@/axios/index.js';

export function loginUserInfo() {
    return http.get('/my/loginUserInfo')
}

export function resetPassword(password) {
    return http.put('/my/resetPassword', {password})
}

export function userDelete() {
    return http.delete('/my/delete')
}

export function myOauthBindings() {
    return http.get('/my/oauthBindings')
}

export function myOauthBind(platform, code, redirectUri) {
    return http.post('/my/oauthBind', {platform, code, redirectUri})
}

export function myOauthUnbind(oauthUserId) {
    return http.delete('/my/oauthUnbind', {params: {oauthUserId}})
}

export function myPushGet() {
    return http.get('/my/push/get')
}

export function myPushSave(params) {
    return http.post('/my/push/save', params)
}

export function myPushDelete() {
    return http.delete('/my/push/delete')
}

export function myPushTest() {
    return http.post('/my/push/test')
}

