<template>
  <div class="apply-admin">
    <div class="header-actions">
      <el-select v-model="query.status" class="status-select" :placeholder="$t('all')" clearable @change="search">
        <el-option :label="$t('auditPending')" :value="0"/>
        <el-option :label="$t('auditApproved')" :value="1"/>
        <el-option :label="$t('auditRejected')" :value="2"/>
      </el-select>
      <div class="search">
        <el-input v-model="query.keyword" class="search-input" :placeholder="$t('searchApplyDesc')"
                  @keyup.enter="search"/>
      </div>
      <Icon class="icon" icon="iconoir:search" width="20" height="20" @click="search"/>
      <Icon class="icon" icon="ion:reload" width="18" height="18" @click="refresh"/>
      <el-tooltip effect="dark" :content="$t('batchReview')" placement="top">
        <Icon class="icon" :class="batchRunning ? 'running' : ''" icon="fluent:bot-24-regular" width="20" height="20"
              @click="batchReview"/>
      </el-tooltip>
    </div>

    <el-alert v-if="batchRunning" type="warning" :closable="false" class="batch-alert">
      <template #title>
        {{ $t('batchRunningMsg', {processed: batchProgress.processed, approved: batchProgress.approved, rejected: batchProgress.rejected, kept: batchProgress.kept, remaining: batchProgress.remaining}) }}
      </template>
    </el-alert>

    <el-scrollbar class="scrollbar">
      <div class="loading" :class="listLoading ? 'loading-show' : 'loading-hide'" :style="first ? 'background: transparent' : ''">
        <loading/>
      </div>

      <el-table v-if="!listLoading || tableShow" :data="tableData" :fit="true" style="width: 100%">
        <el-table-column :label="$t('applicant')" :min-width="180" fixed="left">
          <template #default="{row}">
            <div class="applicant-cell">
              <el-avatar :size="28" :src="row.avatar">{{ (row.username || '?').slice(0, 1).toUpperCase() }}</el-avatar>
              <span class="username">{{ row.username }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="platform" :label="$t('oauthSetting')" :width="90"/>
        <el-table-column prop="regCode" :label="$t('applyRegKeyCol')" :width="110" :show-overflow-tooltip="true">
          <template #default="{row}">{{ row.regCode || '—' }}</template>
        </el-table-column>
        <el-table-column :label="$t('trustLevel')" :width="100">
          <template #default="{row}">
            <el-tag v-if="row.trustLevel !== null && row.trustLevel !== undefined"
                    :type="trustTagType(row.trustLevel)">TL{{ row.trustLevel }}
            </el-tag>
            <el-tag v-else type="info">{{ $t('unknownLevel') }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="email" :label="$t('applyAddress')" :min-width="200" :show-overflow-tooltip="true"/>
        <el-table-column prop="reason" :label="$t('applyReason')" :min-width="220" :show-overflow-tooltip="true"/>
        <el-table-column :label="$t('applyStatusLabel')" :width="100">
          <template #default="{row}">
            <el-tag v-if="row.status === 0" type="warning">{{ $t('auditPending') }}</el-tag>
            <el-tag v-else-if="row.status === 1" type="success">{{ $t('auditApproved') }}</el-tag>
            <el-tag v-else type="danger">{{ $t('auditRejected') }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="remark" :label="$t('applyRejectReason')" :min-width="140" :show-overflow-tooltip="true"/>
        <el-table-column prop="createTime" :label="$t('date')" :width="165" :formatter="formatTime" fixed="right"/>
        <el-table-column :label="$t('operate')" :width="130" fixed="right">
          <template #default="{row}">
            <template v-if="row.status === 0">
              <el-button link type="primary" size="small" @click="openApprove(row)">{{ $t('auditApprove') }}</el-button>
              <el-button link type="danger" size="small" @click="openReject(row)">{{ $t('auditReject') }}</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>

      <div class="empty" v-if="tableData.length === 0 && !first">
        <el-empty :image-size="isMobile ? 120 : null" :description="$t('noApplyFound')"/>
      </div>
    </el-scrollbar>

    <div class="pagination-box">
      <el-pagination
          v-model:current-page="query.num"
          v-model:page-size="query.size"
          :total="total"
          :page-sizes="[10,15,20,25,30,50]"
          layout="total, sizes, prev, pager, next"
          background
          @size-change="sizeChange"
          @current-change="getList"
      />
    </div>

    <el-dialog v-model="rejectShow" :title="$t('auditReject')" width="400px">
      <el-input v-model="rejectRemark" type="textarea" :rows="3" maxlength="200" show-word-limit
                :placeholder="$t('rejectRemarkPh')"/>
      <template #footer>
        <el-button @click="rejectShow = false">{{ $t('cancel') }}</el-button>
        <el-button type="danger" :loading="auditLoading" @click="submitReject">{{ $t('confirm') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import {computed, defineOptions, onMounted, onUnmounted, reactive, ref} from "vue";
import {Icon} from "@iconify/vue";
import loading from "@/components/loading/index.vue";
import {useSettingStore} from "@/store/setting.js";
import {applyApprove, applyBatchReview, applyBatchStatus, applyList, applyReject} from "@/request/apply.js";
import {tzDayjs} from "@/utils/day.js";
import {useI18n} from "vue-i18n";

defineOptions({
  name: 'apply-admin'
})

const {t} = useI18n()
const settingStore = useSettingStore()

const isMobile = ref(window.innerWidth < 768)

const query = reactive({
  num: 1,
  size: 15,
  status: '',
  keyword: ''
})

const total = ref(0)
const tableData = ref([])
const listLoading = ref(false)
const first = ref(true)
const tableShow = ref(false)

const rejectShow = ref(false)
const rejectRemark = ref('')
const currentRow = ref(null)
const auditLoading = ref(false)
const batchRunning = ref(false)
const batchProgress = reactive({processed: 0, approved: 0, rejected: 0, kept: 0, remaining: 0})
let statusTimer = null

function trustTagType(level) {
  if (level >= 3) return 'success'
  if (level === 2) return 'primary'
  return 'info'
}

function formatTime(row) {
  if (!row.createTime) return ''
  return tzDayjs(row.createTime).format('YYYY-MM-DD HH:mm')
}

async function getList() {

  listLoading.value = true

  try {
    const data = await applyList({
      num: query.num,
      size: query.size,
      status: query.status,
      keyword: query.keyword
    })
    tableData.value = data.list || []
    total.value = data.total || 0
  } finally {
    first.value = false
    listLoading.value = false
    tableShow.value = true
  }
}

function search() {
  query.num = 1
  getList()
}

function refresh() {
  getList()
}

function sizeChange() {
  query.num = 1
  getList()
}

function openApprove(row) {

  ElMessageBox.confirm(t('confirmApproveMsg'), t('applyAudit'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'success'
  }).then(async () => {
    auditLoading.value = true
    try {
      await applyApprove(row.applyId)
      ElMessage({message: t('setSuccess'), type: 'success', plain: true})
      getList()
    } finally {
      auditLoading.value = false
    }
  }).catch(() => {
  })
}

function openReject(row) {
  currentRow.value = row
  rejectRemark.value = ''
  rejectShow.value = true
}

async function submitReject() {

  if (!currentRow.value) return

  auditLoading.value = true

  try {
    await applyReject(currentRow.value.applyId, rejectRemark.value)
    rejectShow.value = false
    ElMessage({message: t('setSuccess'), type: 'success', plain: true})
    getList()
  } finally {
    auditLoading.value = false
  }
}

async function batchReview() {

  if (batchRunning.value) return

  try {
    await ElMessageBox.confirm(t('batchReviewConfirm'), t('applyAudit'), {
      confirmButtonText: t('confirm'),
      cancelButtonText: t('cancel'),
      type: 'warning'
    })
  } catch (e) {
    return
  }

  const data = await applyBatchReview()

  if (!data.queued) {
    ElMessage({message: t('noApplyFound'), type: 'info', plain: true})
    return
  }

  ElMessage({
    message: t('batchStarted', {queued: data.queued}),
    type: 'success',
    plain: true,
    duration: 5000
  })

  batchRunning.value = true
  startBatchPolling()
}

function startBatchPolling() {
  stopBatchPolling()
  statusTimer = setInterval(pollBatchStatus, 3000)
  pollBatchStatus()
}

function stopBatchPolling() {
  if (statusTimer) {
    clearInterval(statusTimer)
    statusTimer = null
  }
}

async function pollBatchStatus() {

  try {
    const st = await applyBatchStatus()

    if (st.running) {
      batchRunning.value = true
      if (st.stats) {
        batchProgress.processed = st.stats.processed
        batchProgress.approved = st.stats.approved
        batchProgress.rejected = st.stats.rejected
        batchProgress.kept = st.stats.kept
        batchProgress.remaining = st.stats.remaining
      }
    } else {
      stopBatchPolling()
      if (batchRunning.value) {
        batchRunning.value = false
        ElMessage({
          message: t('batchDoneSummary', {
            processed: st.stats?.processed ?? 0,
            approved: st.stats?.approved ?? 0,
            rejected: st.stats?.rejected ?? 0,
            kept: st.stats?.kept ?? 0
          }),
          type: 'success',
          plain: true,
          duration: 6000
        })
        getList()
      }
    }
  } catch (e) {
    // 轮询失败不打断：下一轮重试
  }
}

onMounted(async () => {
  getList()
  // 进入页面时若后台队列仍在运行，恢复进度显示
  try {
    const st = await applyBatchStatus()
    if (st.running) {
      batchRunning.value = true
      startBatchPolling()
    }
  } catch (e) {
    // 忽略：状态获取失败按未运行处理
  }
})

onUnmounted(stopBatchPolling)

</script>

<style lang="scss" scoped>

.apply-admin {
  position: relative;
  height: 100%;
  overflow: hidden;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;

  .status-select {
    width: 130px;
  }

  .search {
    flex: 1;
    max-width: 300px;
  }

  .icon {
    cursor: pointer;
    color: var(--el-text-color-secondary);

    &:hover {
      color: var(--el-color-primary);
    }

    &.running {
      opacity: 0.35;
      pointer-events: none;
    }
  }
}

.batch-alert {
  margin: 0 10px 10px;
}

.scrollbar {
  height: calc(100% - 110px);
  padding: 0 10px;
}

.loading {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  background: var(--loadding-background);
  z-index: 2;
}

.loading-show {
  transition: all 200ms ease 200ms;
  opacity: 1;
}

.loading-hide {
  pointer-events: none;
  transition: var(--loading-hide-transition);
  opacity: 0;
}

.applicant-cell {
  display: flex;
  align-items: center;
  gap: 8px;

  .username {
    font-weight: 500;
  }
}

.pagination-box {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
  padding: 10px;
}
</style>
