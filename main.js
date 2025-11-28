require('dotenv').config()
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')

/**
 * 從環境變數讀取設定
 * @returns {Object} 設定物件
 */
function loadConfig() {
  const requiredEnvVars = [
    'CLOCK_IN_URL',
    'USER_ID',
    'USER_PASSWORD',
    'TIME_RANGE_START',
    'TIME_RANGE_END',
  ]
  const missing = requiredEnvVars.filter((varName) => !process.env[varName])

  if (missing.length > 0) {
    throw new Error(`缺少必要的環境變數: ${missing.join(', ')}。請確認 .env 檔案已正確設定。`)
  }

  return {
    webUrl: process.env.CLOCK_IN_URL,
    range: {
      start: process.env.TIME_RANGE_START,
      end: process.env.TIME_RANGE_END,
    },
    user: {
      id: process.env.USER_ID,
      pwd: process.env.USER_PASSWORD,
    },
  }
}

/**
 * 讀取 JSON 檔案
 * @param {string} filename 檔案路徑
 * @returns {Object} JSON 物件
 */
function readJsonFile(filename) {
  try {
    const data = fs.readFileSync(filename, 'utf8')
    return JSON.parse(data)
  } catch (error) {
    throw new Error(`無法讀取 ${filename}: ${error.message}`)
  }
}

/**
 * 解析時間字串為小時和分鐘
 * @param {string} timeStr 時間字串 (格式: "HH:mm")
 * @returns {Object} 包含小時和分鐘的物件
 */
function parseTime(timeStr) {
  const [hour, minute] = timeStr.split(':').map(Number)
  return { hour, minute }
}

/**
 * 在指定時間範圍內產生隨機時間
 * @param {string} startTime 開始時間 (格式: "HH:mm")
 * @param {string} endTime 結束時間 (格式: "HH:mm")
 * @returns {Object} 包含隨機小時和分鐘的物件
 */
function getRandomTime(startTime, endTime) {
  const start = parseTime(startTime)
  const end = parseTime(endTime)

  // 轉換為分鐘數以便計算
  const startMinutes = start.hour * 60 + start.minute
  const endMinutes = end.hour * 60 + end.minute

  // 產生隨機分鐘數
  const randomMinutes = Math.floor(Math.random() * (endMinutes - startMinutes + 1)) + startMinutes

  // 轉換回小時和分鐘
  const hour = Math.floor(randomMinutes / 60)
  const minute = randomMinutes % 60

  return { hour, minute }
}

/**
 * 準備打卡資訊
 * @param {Array<string>} clockInDates 打卡日期陣列
 * @param {Object} timeRange 時間範圍設定
 * @returns {Array<Object>} 打卡資訊陣列
 */
function prepareTempClockInList(clockInDates, timeRange) {
  return clockInDates.map((date) => {
    const randomTime = getRandomTime(timeRange.start, timeRange.end)
    return {
      date: date,
      h: randomTime.hour,
      m: randomTime.minute,
    }
  })
}

/**
 * 執行單次打卡
 * @param {Object} page Playwright 頁面物件
 * @param {Object} config 設定物件（包含 user 和 webUrl）
 * @param {Object} clockInInfo 打卡資訊
 * @returns {Object} 打卡結果
 */
async function performClockIn(page, config, clockInInfo) {
  try {
    console.log(
      `正在處理 ${clockInInfo.date} ${clockInInfo.h}:${clockInInfo.m
        .toString()
        .padStart(2, '0')} 的打卡...`,
    )

    // 前往打卡頁面
    await page.goto(config.webUrl)
    await page.waitForURL(config.webUrl)

    // 輸入 ID
    const idInput = page.getByRole('textbox', { name: 'ID Number' })
    await idInput.clear()
    await idInput.fill(config.user.id)

    // 輸入密碼
    const pwdInput = page.getByRole('textbox', { name: '密碼' })
    await pwdInput.clear()
    await pwdInput.fill(config.user.pwd)

    // 輸入日期
    await page.locator('#txtDate').click()
    const datePicker = page.locator('.ui-datepicker-calendar')
    await datePicker.waitFor({ state: 'visible' })

    const targetDate = new Date(clockInInfo.date).getDate().toString()
    await datePicker.getByRole('link', { name: targetDate, exact: true }).click()

    // 輸入時
    const hourInput = page.locator('#txtHour')
    await hourInput.clear()
    await hourInput.fill(clockInInfo.h.toString())

    // 輸入分
    const minuteInput = page.locator('#txtMinute')
    await minuteInput.clear()
    await minuteInput.fill(clockInInfo.m.toString())

    // 點擊確定補登按鈕
    const submitButton = page.getByRole('button', { name: '確定補登' })
    await submitButton.click()

    // 等待頁面跳轉或回應
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000) // 額外等待 1 秒確保處理完成

    // 檢查是否有成功訊息或錯誤訊息
    const pageContent = await page.content()
    const successIndicators = ['補登成功', '成功', '已完成']
    const errorIndicators = ['錯誤', '失敗', '無效', '請重新', '不能', '無法']

    let status = 'unknown'
    let message = '無法確定結果'

    if (successIndicators.some((indicator) => pageContent.includes(indicator))) {
      status = 'success'
      message = '打卡成功'
    } else if (errorIndicators.some((indicator) => pageContent.includes(indicator))) {
      status = 'error'
      message = '打卡失敗'
    } else {
      // 如果沒有明確的成功或失敗訊息，檢查是否回到原頁面
      const currentUrl = page.url()
      if (currentUrl.includes('AddSignInRecord.aspx')) {
        status = 'success'
        message = '打卡完成（頁面已重新載入）'
      }
    }

    return {
      date: clockInInfo.date,
      time: `${clockInInfo.h}:${clockInInfo.m.toString().padStart(2, '0')}`,
      status: status,
      message: message,
      timestamp: new Date().toISOString(),
    }
  } catch (error) {
    console.error(`打卡失敗 (${clockInInfo.date}):`, error.message)
    return {
      date: clockInInfo.date,
      time: `${clockInInfo.h}:${clockInInfo.m.toString().padStart(2, '0')}`,
      status: 'error',
      message: `執行錯誤: ${error.message}`,
      timestamp: new Date().toISOString(),
    }
  }
}

/**
 * 儲存打卡結果到 logs 資料夾
 * @param {Array<Object>} results 打卡結果陣列
 */
function saveResults(results) {
  // 確保 logs 資料夾存在
  const logsDir = path.join(__dirname, 'logs')
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
  }

  // 產生檔案名稱（包含日期和時間）
  const now = new Date()
  const dateStr = now.toISOString().split('T')[0]
  const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-')
  const filename = `clock-in-log-${dateStr}-${timeStr}.json`
  const filepath = path.join(logsDir, filename)

  const data = {
    executionDate: now.toISOString(),
    totalRecords: results.length,
    successCount: results.filter((r) => r.status === 'success').length,
    errorCount: results.filter((r) => r.status === 'error').length,
    unknownCount: results.filter((r) => r.status === 'unknown').length,
    results: results,
  }

  try {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8')
    console.log(`\n打卡結果已儲存到: ${filepath}`)
  } catch (error) {
    console.error('儲存結果時發生錯誤:', error.message)
  }
}

/**
 * 主程式
 */
async function main() {
  let browser = null

  try {
    console.log('=== 自動打卡程式啟動 ===\n')

    // 步驟1: 讀取設定檔
    console.log('正在讀取環境變數設定...')

    // 從環境變數讀取設定
    const config = loadConfig()

    console.log(`打卡網址: ${config.webUrl}`)
    console.log(`使用者 ID: ${config.user.id}`)
    console.log(`時間範圍: ${config.range.start} - ${config.range.end}`)

    // 讀取打卡日期
    const selectDateFilePath = path.join(__dirname, 'selected-dates.json')
    console.log(`使用日期檔案: ${selectDateFilePath}`)
    const selectDateData = readJsonFile(selectDateFilePath)

    if (!selectDateData.selectedDates || selectDateData.selectedDates.length === 0) {
      throw new Error('selected-dates.json 檔案中沒有找到 selectedDates 資料')
    }

    console.log(`發現 ${selectDateData.selectedDates.length} 個打卡日期`)
    console.log(`時間範圍: ${config.range.start} - ${config.range.end}`)

    // 步驟2: 準備打卡資訊
    console.log('\n正在準備打卡資訊...')
    const tempClockInList = prepareTempClockInList(selectDateData.selectedDates, config.range)

    console.log(`共有 ${tempClockInList.length} 個打卡記錄需要處理:`)
    tempClockInList.forEach((item, index) => {
      console.log(`${index + 1}. ${item.date} ${item.h}:${item.m.toString().padStart(2, '0')}`)
    })

    // 步驟3: 啟動瀏覽器
    console.log('\n正在啟動瀏覽器...')
    browser = await chromium.launch({
      headless: false, // 設為 true 可隱藏瀏覽器視窗
      slowMo: 1000, // 每個操作間隔 1 秒，便於觀察
    })

    const context = await browser.newContext()
    const page = await context.newPage()

    // 步驟4: 執行打卡
    console.log('\n開始執行打卡程序...\n')
    const results = []

    for (let i = 0; i < tempClockInList.length; i++) {
      const clockInInfo = tempClockInList[i]
      console.log(`\n[${i + 1}/${tempClockInList.length}]`)

      const result = await performClockIn(page, config, clockInInfo)
      results.push(result)

      console.log(`結果: ${result.status} - ${result.message}`)

      // 在每次打卡之間稍作休息
      if (i < tempClockInList.length - 1) {
        console.log('等待 3 秒後繼續下一個...')
        await page.waitForTimeout(3000)
      }
    }

    // 步驟5: 顯示結果摘要
    console.log('\n=== 執行結果摘要 ===')
    const successCount = results.filter((r) => r.status === 'success').length
    const errorCount = results.filter((r) => r.status === 'error').length
    const unknownCount = results.filter((r) => r.status === 'unknown').length

    console.log(`總處理筆數: ${results.length}`)
    console.log(`成功: ${successCount}`)
    console.log(`失敗: ${errorCount}`)
    console.log(`未知: ${unknownCount}`)

    if (successCount > 0) {
      console.log('\n✅ 成功的打卡記錄:')
      results
        .filter((r) => r.status === 'success')
        .forEach((r) => {
          console.log(`   ${r.date} ${r.time} - ${r.message}`)
        })
    }

    if (errorCount > 0) {
      console.log('\n❌ 失敗的打卡記錄:')
      results
        .filter((r) => r.status === 'error')
        .forEach((r) => {
          console.log(`   ${r.date} ${r.time} - ${r.message}`)
        })
    }

    if (unknownCount > 0) {
      console.log('\n❓ 未知狀態的打卡記錄:')
      results
        .filter((r) => r.status === 'unknown')
        .forEach((r) => {
          console.log(`   ${r.date} ${r.time} - ${r.message}`)
        })
    }

    // 步驟6: 儲存結果
    saveResults(results)
  } catch (error) {
    console.error('程式執行時發生錯誤:', error.message)
  } finally {
    if (browser) {
      await browser.close()
    }
    console.log('\n程式執行完畢。')
  }
}

// 執行主程式
if (require.main === module) {
  main().catch(console.error)
}

module.exports = {
  main,
  loadConfig,
  readJsonFile,
  getRandomTime,
  prepareTempClockInList,
  performClockIn,
  saveResults,
}
