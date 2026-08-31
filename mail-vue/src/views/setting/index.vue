<template>
  <div class="box">
    <div class="container">
      <div class="title">{{$t('profile')}}</div>
      <div class="item">
        <div>{{$t('username')}}</div>
        <div>
          <span v-if="setNameShow" class="edit-name-input">
            <el-input v-model="accountName"  ></el-input>
            <span class="edit-name" @click="setName">
             {{$t('save')}}
            </span>
          </span>
          <span v-else class="user-name">
            <span >{{ userStore.user.name }}</span>
            <span class="edit-name" @click="showSetName">
             {{$t('change')}}
            </span>
          </span>
        </div>
      </div>
      <div class="item">
        <div>{{$t('emailAccount')}}</div>
        <div>{{ userStore.user.email }}</div>
      </div>
      <div class="item">
        <div>{{$t('password')}}</div>
        <div>
          <el-button type="primary" @click="pwdShow = true">{{$t('changePwdBtn')}}</el-button>
        </div>
      </div>
    </div>
    <div class="oauth">
      <div class="title">{{$t('oauthBindingTitle')}}</div>
      <div class="oauth-desc">{{$t('oauthBindingDesc')}}</div>
      <div v-for="b in bindings" :key="b.oauthUserId" class="oauth-row">
        <el-avatar v-if="providerMeta[b.platform] && providerMeta[b.platform].iconType === 'image'" :src="providerMeta[b.platform].icon" :size="18"/>
        <Icon v-else-if="providerMeta[b.platform]" :icon="providerMeta[b.platform].icon" width="18" height="18"/>
        <Icon v-else icon="mdi:link-variant" width="18" height="18"/>
        <span class="oauth-name">{{ b.username || b.name || b.platform }}</span>
        <el-button link type="danger" size="small" :disabled="bindings.length <= 1" @click="unbindConfirm(b)">{{$t('oauthUnbindBtn')}}</el-button>
      </div>
      <div v-for="p in bindableProviders" :key="p.key" class="oauth-row">
        <el-avatar v-if="p.iconType === 'image'" :src="p.icon" :size="18"/>
        <Icon v-else :icon="p.icon" width="18" height="18"/>
        <span class="oauth-name">{{ p.label }}</span>
        <el-button link type="primary" size="small" @click="bindProvider(p.key)">{{$t('oauthBindBtn')}}</el-button>
      </div>
      <div v-if="!bindings.length && !bindableProviders.length" class="oauth-empty">{{$t('oauthNoneAvailable')}}</div>
    </div>
    <div class="push" v-if="settingStore.settings.userPushStatus === 0">
      <div class="title">{{$t('pushNotifyTitle')}}</div>
      <div class="push-desc">{{$t('pushNotifyDesc')}}</div>
      <div class="push-form">
        <el-select v-model="pushForm.channel" class="push-channel" :placeholder="$t('pushChannel')">
          <el-option label="Bark" value="bark"/>
          <el-option label="Server酱" value="serverchan"/>
          <el-option :label="$t('pushChannelWebhook')" value="webhook"/>
        </el-select>
        <el-input
            v-model="pushForm.secret"
            class="push-secret"
            :placeholder="pushSecretPlaceholder"
            show-password
        />
      </div>
      <div class="push-actions">
        <el-switch
            v-model="pushForm.status"
            :active-value="0"
            :inactive-value="1"
            :active-text="$t('enable')"
            :inactive-text="$t('disable')"
        />
        <el-tooltip effect="dark" :content="$t('pushCopyCodeTip')">
          <div style="display: flex; align-items: center; gap: 6px">
            <span style="font-size: 12px">{{ $t('pushCopyCode') }}</span>
            <el-switch
                v-model="pushForm.copyCode"
                :active-value="1"
                :inactive-value="0"
            />
          </div>
        </el-tooltip>
        <div class="push-buttons">
          <el-button size="small" :loading="pushTesting" @click="pushTest">{{$t('pushTest')}}</el-button>
          <el-button size="small" type="primary" :loading="pushSaving" @click="pushSave">{{$t('save')}}</el-button>
          <el-button v-if="pushInfo" size="small" type="danger" plain @click="pushRemove">{{$t('pushDelete')}}</el-button>
        </div>
      </div>
      <div v-if="pushInfo" class="push-current">
        {{$t('pushConfigured')}}：{{ pushInfo.channel === 'bark' ? 'Bark' : pushInfo.channel === 'serverchan' ? 'Server酱' : 'Webhook' }} · {{ pushInfo.secretMasked }}
      </div>
    </div>
    <div class="language">
      <div class="title">{{$t('language')}}</div>
      <el-select
          :model-value="langSelect"
          class="language-select"
          placeholder="Select"
          @change="changeLang"
      >
        <el-option label="中文" value="zh" @pointerdown.prevent.stop="changeLang('zh')"/>
        <el-option label="English" value="en" @pointerdown.prevent.stop="changeLang('en')"/>
      </el-select>
    </div>
    <div class="del-email" v-perm="'my:delete'">
      <div class="title">{{$t('deleteUser')}}</div>
      <div style="color: var(--regular-text-color);">
        {{$t('delAccountMsg')}}
      </div>
      <div>
        <el-button type="primary" @click="deleteConfirm">{{$t('deleteUserBtn')}}</el-button>
      </div>
    </div>
    <el-dialog v-model="pwdShow" :title="$t('changePassword')" width="340">
      <div class="update-pwd">
        <el-input type="password" :placeholder="$t('newPassword')" v-model="form.password" autocomplete="off" @keyup.enter="submitPwd"/>
        <el-input type="password" :placeholder="$t('confirmPassword')" v-model="form.newPwd" autocomplete="off" @keyup.enter="submitPwd"/>
        <el-button type="primary" :loading="setPwdLoading" @click="submitPwd">{{$t('save')}}</el-button>
      </div>
    </el-dialog>
  </div>
</template>
<script setup>
import {reactive, ref, computed, defineOptions} from 'vue'
import {resetPassword, userDelete, myOauthBindings, myOauthUnbind, myPushGet, myPushSave, myPushDelete, myPushTest} from "@/request/my.js";
import {useUserStore} from "@/store/user.js";
import router from "@/router/index.js";
import {accountSetName} from "@/request/account.js";
import {useAccountStore} from "@/store/account.js";
import {useI18n} from "vue-i18n";
import {useSettingStore} from "@/store/setting.js";
import {Icon} from "@iconify/vue";
import {launchOauth} from "@/utils/oauth.js";

const { t } = useI18n()
const accountStore = useAccountStore()
const settingStore = useSettingStore()
const userStore = useUserStore();
const setPwdLoading = ref(false)
const setNameShow = ref(false)
const accountName = ref(null)
const langSelect = ref(settingStore.lang)

// 第三方登录绑定：列表 / 追加绑定（跳 OAuth 回登录页走 bind 分支）/ 解绑（后端保底最后一个不可解）
const bindings = ref([])

const providerMeta = {
  linuxdo: {label: 'LinuxDo', icon: '/image/linuxdo.webp', iconType: 'image'},
  github: {label: 'GitHub', icon: 'codicon:github-inverted', iconType: 'iconify'},
  google: {label: 'Google', icon: 'devicon:google', iconType: 'iconify'},
}

const bindableProviders = computed(() => {
  return Object.keys(providerMeta)
      .filter(key => settingStore.settings[key + 'Switch'] === 0 && settingStore.settings[key + 'ClientId'])
      .filter(key => !bindings.value.some(b => b.platform === key))
      .map(key => ({key, ...providerMeta[key]}))
})

async function getBindings() {
  bindings.value = (await myOauthBindings()) || []
}

function bindProvider(platform) {
  const clientId = settingStore.settings[platform + 'ClientId']
  launchOauth(platform, clientId, 'bind')
}

function unbindConfirm(row) {
  ElMessageBox.confirm(t('oauthUnbindConfirm'), t('oauthBindingTitle'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(async () => {
    await myOauthUnbind(row.oauthUserId)
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })
    await getBindings()
  }).catch(() => {
  })
}

getBindings()

// 邮件推送通知：渠道配置仅保存凭证，测试按已保存的配置发送
const pushForm = reactive({ channel: 'bark', secret: '', status: 0, copyCode: 0 })
const pushInfo = ref(null)
const pushSaving = ref(false)
const pushTesting = ref(false)

const pushSecretPlaceholder = computed(() => {
  if (pushForm.channel === 'bark') return t('pushBarkPlaceholder')
  if (pushForm.channel === 'serverchan') return t('pushServerchanPlaceholder')
  return t('pushWebhookPlaceholder')
})

async function getPush() {
  pushInfo.value = await myPushGet()
  if (pushInfo.value) {
    pushForm.channel = pushInfo.value.channel
    pushForm.status = pushInfo.value.status
    pushForm.copyCode = Number(pushInfo.value.copyCode) === 1 ? 1 : 0
  }
}

function pushSave() {

  if (pushSaving.value) return

  // 已配置过且未重填凭证：只提交渠道/状态/验证码开关，后端保留原凭证（切开关不必重填密钥）
  let payload
  if (!pushForm.secret) {
    if (!pushInfo.value) {
      ElMessage({
        message: t('pushMissingConfig'),
        type: 'error',
        plain: true,
      })
      return
    }
    payload = { channel: pushForm.channel, status: pushForm.status, copyCode: pushForm.copyCode }
  } else {
    payload = { channel: pushForm.channel, secret: pushForm.secret, status: pushForm.status, copyCode: pushForm.copyCode }
  }

  pushSaving.value = true
  myPushSave(payload).then(() => {
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })
    pushForm.secret = ''
    getPush()
  }).finally(() => {
    pushSaving.value = false
  })
}

function pushTest() {

  if (pushTesting.value) return

  pushTesting.value = true
  myPushTest().then(() => {
    ElMessage({
      message: t('pushTestOk'),
      type: 'success',
      plain: true,
    })
  }).finally(() => {
    pushTesting.value = false
  })
}

function pushRemove() {
  ElMessageBox.confirm(t('pushRemoveConfirm'), t('pushNotifyTitle'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    myPushDelete().then(() => {
      pushInfo.value = null
      pushForm.secret = ''
      ElMessage({
        message: t('saveSuccessMsg'),
        type: 'success',
        plain: true,
      })
    })
  })
}

getPush()

defineOptions({
  name: 'setting'
})

function showSetName() {
  accountName.value = userStore.user.name
  setNameShow.value = true
}

function setName() {

  if (!accountName.value) {
    ElMessage({
      message: t('emptyUserNameMsg'),
      type: 'error',
      plain: true,
    })
    return;
  }

  setNameShow.value = false
  let name = accountName.value

  if (name === userStore.user.name) {
    return
  }

  userStore.user.name = accountName.value

  accountSetName(userStore.user.account.accountId,name).then(() => {
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })

    accountStore.changeUserAccountName = name

  }).catch(() => {
    userStore.user.name = name
  })
}

function changeLang(lang) {
  let setting = {}
  try {
    setting = JSON.parse(localStorage.getItem('setting') || '{}')
  } catch (e) {
    setting = {}
  }
  localStorage.setItem('setting', JSON.stringify({...setting, lang}))
  window.location.reload()
}

const pwdShow = ref(false)
const form = reactive({
  password: '',
  newPwd: '',
})

const deleteConfirm = () => {
  ElMessageBox.confirm(t('delAccountConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    userDelete().then(() => {
      localStorage.removeItem('token');
      router.replace('/login');
      ElMessage({
        message: t('delSuccessMsg'),
        type: 'success',
        plain: true,
      })
    })
  })
}


function submitPwd() {

  if (setPwdLoading.value) return

  if (!form.password) {
    ElMessage({
      message: t('emptyPwdMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (form.password.length < 6) {
    ElMessage({
      message: t('pwdLengthMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (form.password !== form.newPwd) {
    ElMessage({
      message: t('confirmPwdFailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  setPwdLoading.value = true
  resetPassword(form.password).then(() => {
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })
    pwdShow.value = false
    setPwdLoading.value = false
    form.password = ''
    form.newPwd = ''
  }).catch(() => {
    setPwdLoading.value = false
  })

}

</script>
<style scoped lang="scss">
.box {
  padding: 40px 40px;

  @media (max-width: 767px) {
    padding: 30px 30px;
  }

  .update-pwd {
    display: flex;
    flex-direction: column;
    gap: 15px;
  }

  .title {
    font-size: 18px;
    font-weight: bold;
  }

  .container {
    font-size: 14px;
    display: grid;
    gap: 20px;
    margin-bottom: 40px;

    .item {
      display: grid;
      grid-template-columns: 50px 1fr;
      gap: 140px;
      position: relative;
      .user-name {
        display: grid;
        grid-template-columns: auto 1fr;
        span:first-child {
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        }
      }

      .edit-name-input {
        position: absolute;
        bottom: -6px;
        .el-input {
          width: min(200px,calc(100vw - 222px));
        }
      }

      .edit-name {
        color: #4dabff;
        padding-left: 10px;
        cursor: pointer;
      }

      @media (max-width: 767px) {
        gap: 70px;
      }

      div:first-child {
        font-weight: bold;
      }

      div:last-child {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
    }
  }

  .language {
    display: flex;
    flex-direction: column;
    gap: 20px;
    margin-bottom: 40px;

    .language-select {
      width: 100px;
    }
  }

  .oauth {
    font-size: 14px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    margin-bottom: 40px;

    .oauth-desc {
      color: var(--regular-text-color);
    }

    .oauth-row {
      display: flex;
      align-items: center;
      gap: 10px;

      .oauth-name {
        flex: 1;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
    }

    .oauth-empty {
      color: var(--regular-text-color);
    }
  }

  .push {
    font-size: 14px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    margin-bottom: 40px;

    .push-desc {
      color: var(--regular-text-color);
      margin-top: -10px;
    }

    .push-form {
      display: flex;
      gap: 10px;

      .push-channel {
        width: 150px;
        flex-shrink: 0;
      }

      .push-secret {
        flex: 1;
      }
    }

    .push-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;

      .push-buttons {
        display: flex;
        gap: 10px;
      }
    }

    .push-current {
      color: var(--regular-text-color);
    }
  }

  .del-email {
    font-size: 14px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
}
</style>
