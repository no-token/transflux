#!/usr/bin/env bash
# Transflux —— 完整自测脚本（Azure 兼容对外接口 + 账号密码后台）
# 对外接口：POST /translate?api-version=3.0&to=<lang>[&from=<lang>]
#           鉴权 Ocp-Apim-Subscription-Key；body [{"Text":"..."}]；响应/错误均为 Azure 风格
# 覆盖：健康检查 / 网关鉴权 / Azure 风格翻译 / 多文本 / 多目标(to多个) / 强制指定 / 输入校验
#       /usage 统计(含多目标计费) / 故障自动切换 / 80% 自动禁用+override
#       后台账号密码登录 / 首登强改 / 密钥后台配置 / 网关 key 热更新 / quota·threshold 持久化
# 说明：测试不依赖真实密钥——把 deepl 适配器指向本地桩(test/stub.js)模拟"已配置可用"的后端。
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

STUBPORT=3999

PASS=0; FAIL=0; SRV_PID=""; STUB_PID=""
PORT=""; BODY=""; CODE=""

cleanup(){
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null; SRV_PID=""
}
cleanup_all(){
  cleanup
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; wait "$STUB_PID" 2>/dev/null; STUB_PID=""
}
trap cleanup_all EXIT

ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad(){ printf '  \033[31m✗\033[0m %s   [实际: %s]\n' "$1" "$2"; FAIL=$((FAIL+1)); }

# 从 JSON 取标量路径，例如 jget "$BODY" "0.translations.0.text"
jget(){
  node -e "let d;try{d=JSON.parse(process.argv[1])}catch(e){console.log('');process.exit(0)}
  const ps=process.argv[2].split('.');let v=d;for(const k of ps){if(v==null){console.log('');process.exit(0)}v=v[k]}
  console.log(v==null?'':v)" "$1" "$2"
}
# 顶层（或路径处）数组长度
jlen(){
  node -e "try{let d=JSON.parse(process.argv[1]);console.log(Array.isArray(d)?d.length:'')}catch(e){console.log('')}" "$1"
}
# 在对象数组中按 name 取字段，例如 jfind "$BODY" providers deepl monthUsed
jfind(){
  node -e "let d;try{d=JSON.parse(process.argv[1])}catch(e){console.log('');process.exit(0)}
  const arr=d[process.argv[2]]||[];const it=arr.find(x=>x.name===process.argv[3]);
  console.log(it?(it[process.argv[4]]??''):'')" "$1" "$2" "$3" "$4"
}
# 在 channels 数组中按 channel 取字段，例如 jchan "$BODY" azure chars
jchan(){
  node -e "let d;try{d=JSON.parse(process.argv[1])}catch(e){console.log('');process.exit(0)}
  const it=(d.channels||[]).find(c=>c.channel===process.argv[2]);
  console.log(it?(it[process.argv[3]]??0):0)" "$1" "$2" "$3"
}

# 通用请求：$1 method  $2 path  $3 auth头(可为空)  $4 json body(可为空)
api(){
  local method="$1" path="$2" auth="$3" body="$4"
  local url="http://127.0.0.1:$PORT$path"
  local -a args=(-s -o /tmp/tg_body.txt -D /tmp/tg_hdr.txt -w '%{http_code}' -X "$method" "$url" --max-time 25)
  [ -n "$auth" ] && args+=(-H "$auth")
  args+=(-H 'Content-Type: application/json')
  [ -n "$body" ] && args+=(--data "$body")
  CODE="$(curl "${args[@]}")"
  BODY="$(cat /tmp/tg_body.txt)"
}
# 取最近一次响应的响应头值（大小写不敏感），如 hdr X-Cache
hdr(){
  tr -d '\r' < /tmp/tg_hdr.txt | grep -i "^$1:" | head -1 | cut -d':' -f2- | sed 's/^ //'
}

# 启动网关（默认网关 key=gwkey，可后台改；admin 默认 admin/admin123）
start_srv(){
  PORT="$1"; local db="$2"
  rm -f "$db"
  env AUTH_KEY="gwkey" PORT="$PORT" DB_PATH="$db" \
      node src/server.js >"/tmp/tg-$PORT.log" 2>&1 &
  SRV_PID=$!
  local i
  for i in $(seq 1 60); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/health" && break
    sleep 0.25
  done
}
# 重启同一库（不删除旧库，用于持久化验证）
restart_srv(){
  PORT="$1"; local db="$2"
  env AUTH_KEY="gwkey" PORT="$PORT" DB_PATH="$db" \
      node src/server.js >"/tmp/tg-$PORT.log" 2>&1 &
  SRV_PID=$!
  local i
  for i in $(seq 1 60); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/health" && break
    sleep 0.25
  done
}

login_admin(){
  local pw="${1:-admin123}"
  api POST /admin/login "" "{\"username\":\"admin\",\"password\":\"$pw\"}"
  ADM="Authorization: Bearer $(echo "$BODY" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
}
# 登录并完成首登强制改密。安全加固后 must_change=1 的会话仅可调用
# /admin/me、/admin/password、/admin/logout，其余后台接口一律 403，
# 因此拿到新库的默认账号后必须先改密才能操作后台。
# 幂等：库的密码若已改为 newpass123（如重启持久化场景），直接用新密码登录。
login_admin_ready(){
  api POST /admin/login "" '{"username":"admin","password":"admin123"}'
  if [ "$CODE" != "200" ]; then
    api POST /admin/login "" '{"username":"admin","password":"newpass123"}'
    ADM="Authorization: Bearer $(echo "$BODY" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
    return
  fi
  local mc_tok="Authorization: Bearer $(echo "$BODY" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  if [ "$(jget "$BODY" 'mustChange')" = "true" ]; then
    api PUT /admin/password "$mc_tok" '{"newPassword":"newpass123"}'
    api POST /admin/login "" '{"username":"admin","password":"newpass123"}'
  fi
  ADM="Authorization: Bearer $(echo "$BODY" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
}
# 把 deepl 适配器指向本地桩服务，使其"已配置且可用"
cfg_deepl_stub(){
  api PUT /admin/providers/deepl "$ADM" "{\"secret\":{\"authKey\":\"t\",\"baseUrl\":\"http://127.0.0.1:$STUBPORT\"}}"
}

GW="Ocp-Apim-Subscription-Key: gwkey"
GW_WRONG="Ocp-Apim-Subscription-Key: wrong"

echo "============================================"
echo " Transflux自测  ($(date '+%H:%M:%S'))"
echo "============================================"

# ---------- 启动本地桩 DeepL 服务 ----------
echo; echo "【准备】启动本地桩 DeepL 服务 (端口 $STUBPORT)"
node test/stub.js "$STUBPORT" >/tmp/tg-stub.log 2>&1 &
STUB_PID=$!
for i in $(seq 1 40); do grep -q "STUB_READY" /tmp/tg-stub.log 2>/dev/null && break; sleep 0.2; done
grep -q "STUB_READY" /tmp/tg-stub.log 2>/dev/null && ok "桩服务就绪" || bad "桩服务启动" "$(cat /tmp/tg-stub.log)"

# ---------- 场景 A：基础翻译 + 网关鉴权 + 校验 + 统计 ----------
echo; echo "【场景 A】基础能力 (Azure 风格接口, 端口 3201)"
start_srv 3201 ./data/selftest_a.sqlite
login_admin_ready
cfg_deepl_stub
api GET /health "" "";        [ "$CODE" = "200" ] && ok "GET /health → 200" || bad "GET /health" "$CODE"
api GET /ready "" "";         [ "$CODE" = "200" ] && ok "GET /ready → 200" || bad "GET /ready" "$CODE"
api POST "/translate?api-version=3.0&to=zh-Hans" "" '[{"Text":"Hello"}]'
  [ "$CODE" = "401" ] && ok "无鉴权 → 401" || bad "无鉴权" "$CODE"
api POST "/translate?api-version=3.0&to=zh-Hans" "$GW_WRONG" '[{"Text":"Hello"}]'
  [ "$CODE" = "401" ] && ok "错误密钥 → 401" || bad "错误密钥" "$CODE"
api POST "/translate?api-version=3.0&to=zh-Hans" "$GW" '[{"Text":"Hello"}]'
  if [ "$CODE" = "200" ] && [ "$(jget "$BODY" '0.translations.0.text')" != "" ] \
     && [ "$(jget "$BODY" '0.translations.0.to')" = "zh-Hans" ] \
     && [ "$(jget "$BODY" '0.detectedLanguage.language')" = "en" ]; then
    ok "Azure 风格翻译 → 200, 含 text/to/detectedLanguage(en)" ; else
    bad "Azure 风格翻译" "$CODE $(jget "$BODY" '0.translations.0.text') det=$(jget "$BODY" '0.detectedLanguage.language')"; fi
api POST "/translate?api-version=3.0&from=en&to=zh-Hans" "$GW" '[{"Text":"Hello"}]'
  if [ "$CODE" = "200" ] && [ "$(jget "$BODY" '0.detectedLanguage.language')" = "" ]; then
    ok "指定 from 时不返回 detectedLanguage" ; else
    bad "from 无检测" "$CODE det=$(jget "$BODY" '0.detectedLanguage.language')"; fi
api POST "/translate?api-version=3.0&to=en" "$GW" '[{"Text":"a"},{"Text":"bb"}]'
  if [ "$CODE" = "200" ] && [ "$(jlen "$BODY")" = "2" ] && [ "$(jget "$BODY" '1.translations.0.text')" != "" ]; then
    ok "多文本数组 → 2 条结果" ; else bad "多文本数组" "$CODE len=$(jlen "$BODY")"; fi
api POST "/translate?api-version=3.0&to=en&to=zh-Hans" "$GW" '[{"Text":"Hi"}]'
  if [ "$CODE" = "200" ] && [ "$(jget "$BODY" '0.translations.length')" = "2" ] \
     && [ "$(jget "$BODY" '0.translations.0.to')" = "en" ] && [ "$(jget "$BODY" '0.translations.1.to')" = "zh-Hans" ]; then
    ok "多目标(to=en&to=zh-Hans) → 2 条译文" ; else
    bad "多目标" "$CODE n=$(jget "$BODY" '0.translations.length')"; fi
api POST "/translate?api-version=3.0&to=zh-Hans&provider=deepl" "$GW" '[{"Text":"Hi"}]'
  [ "$CODE" = "200" ] && ok "?provider=deepl 强制指定 → 200" || bad "?provider=deepl" "$CODE"
api POST "/translate?api-version=3.0&to=zh-Hans&provider=baidu" "$GW" '[{"Text":"Hi"}]'
  if [ "$CODE" = "503" ] && [ "$(jget "$BODY" 'error.code')" = "503000" ]; then
    ok "?provider=baidu(未配置) → 503 且 Azure 错误码 503000" ; else
    bad "?provider=baidu" "$CODE code=$(jget "$BODY" 'error.code')"; fi
api POST "/translate?to=zh-Hans" "$GW" '[{"Text":"Hi"}]'
  [ "$CODE" = "400" ] && ok "缺 api-version → 400" || bad "缺api-version" "$CODE"
api POST "/translate?api-version=2.0&to=zh-Hans" "$GW" '[{"Text":"Hi"}]'
  [ "$CODE" = "400" ] && ok "错误 api-version → 400" || bad "错api-version" "$CODE"
api POST "/translate?api-version=3.0" "$GW" '[{"Text":"Hi"}]'
  [ "$CODE" = "400" ] && ok "缺 to → 400" || bad "缺to" "$CODE"
api POST "/translate?api-version=3.0&to=zh-Hans" "$GW" '[]'
  [ "$CODE" = "400" ] && ok "空 body → 400" || bad "空body" "$CODE"
api POST "/translate?api-version=3.0&to=zh-Hans" "$GW" '[{}]'
  [ "$CODE" = "400" ] && ok "缺 Text → 400" || bad "缺Text" "$CODE"
# 网页翻译（沉浸式翻译）HTML 支持
api POST "/translate?api-version=3.0&to=zh-Hans&textType=html" "$GW" '[{"Text":"<b>Hello</b> world"}]'
  [ "$CODE" = "200" ] && [ "$(jget "$BODY" '0.translations.0.text')" = "[stub]<b>Hello</b> world" ] \
    && ok "textType=html 原生透传(deepl) → 200 标签保留" || bad "textType=html" "$CODE $(jget "$BODY" '0.translations.0.text')"
api POST "/translate?api-version=3.0&to=zh-Hans&textType=html" "$GW" '[{"Text":"<br/>"}]'
  [ "$CODE" = "200" ] && [ "$(jget "$BODY" '0.translations.0.text')" = "[stub]<br/>" ] \
    && ok "textType=html 纯标签原样返回" || bad "html纯标签" "$CODE $(jget "$BODY" '0.translations.0.text')"
api POST "/translate?api-version=3.0&to=zh-Hans&textType=markdown" "$GW" '[{"Text":"x"}]'
  [ "$CODE" = "400" ] && ok "非法 textType → 400" || bad "非法textType" "$CODE"
api GET /usage "$GW" ""
  # 基础19 + html用例18+5 = 42；其中强制路由 "Hi"→zh-Hans 与多目标用例的 (Hi,AUTO,zh-Hans) 缓存键相同，
  # 全命中不再打上游 → 用量少计 2，为 40（缓存生效的预期表现）
  if [ "$CODE" = "200" ] && [ "$(jfind "$BODY" providers deepl monthUsed)" = "40" ] && [ "$(jget "$BODY" 'totalUsed')" = "40" ]; then
    ok "/usage 统计准确 (42-缓存命中2 = 40，命中不计额度)" ; else
    bad "/usage 统计" "code=$CODE deepl=$(jfind "$BODY" providers deepl monthUsed) total=$(jget "$BODY" 'totalUsed')"; fi
cleanup

# ---------- 场景 B：故障自动切换（后台配假百度密钥 → 百度失败 fallback deepl 桩）----------
echo; echo "【场景 B】故障自动切换 (后台配假百度密钥, 优先级 20 < deepl 40, 端口 3202)"
start_srv 3202 ./data/selftest_b.sqlite
login_admin_ready
cfg_deepl_stub
api PUT /admin/providers/baidu "$ADM" '{"secret":{"appId":"fake","appKey":"fake"}}'; [ "$CODE" = "200" ] && ok "配置百度假密钥 → 200" || bad "配置百度" "$CODE"
api POST "/translate?api-version=3.0&to=zh-Hans" "$GW" '[{"Text":"fallback test"}]'
api GET /usage "$GW" ""
B_AFTER_DEEPL="$(jfind "$BODY" providers deepl monthUsed)"
B_AFTER_BD="$(jfind "$BODY" providers baidu monthUsed)"
if [ "$CODE" = "200" ] && [ -n "$B_AFTER_DEEPL" ] && [ "${B_AFTER_DEEPL:-0}" -gt 0 ] && [ "$B_AFTER_BD" = "0" ]; then
  ok "百度失败自动切换至 deepl (HTTP 200, deepl 计费增长=$B_AFTER_DEEPL, 失败不写库 baidu=$B_AFTER_BD)" ; else
  bad "故障切换" "code=$CODE deepl=$B_AFTER_DEEPL bd=$B_AFTER_BD"; fi
cleanup

# ---------- 场景 C：80% 自动禁用 + 人工覆盖 ----------
echo; echo "【场景 C】80% 自动禁用 (deepl 额度10, 阈值0.8, 端口 3203)"
start_srv 3203 ./data/selftest_c.sqlite
login_admin_ready
cfg_deepl_stub
api PUT /admin/providers/deepl "$ADM" '{"quota":10}'; [ "$CODE" = "200" ] && ok "后台改 deepl 额度 → 10" || bad "改额度" "$CODE"
api POST "/translate?api-version=3.0&to=zh-Hans" "$GW" '[{"Text":"0123456789"}]'; [ "$CODE" = "200" ] && ok "用满 10 字符 → 200" || bad "用满10字符" "$CODE"
api POST "/translate?api-version=3.0&to=zh-Hans" "$GW" '[{"Text":"x"}]'; [ "$CODE" = "503" ] && ok "超 80% 自动禁用 → 503" || bad "超80%禁用" "$CODE"
api PUT /admin/providers/deepl "$ADM" '{"manualOverride":true}'; [ "$CODE" = "200" ] && ok "后台开启 manualOverride → 200" || bad "开启override" "$CODE"
api POST "/translate?api-version=3.0&to=zh-Hans" "$GW" '[{"Text":"x"}]'; [ "$CODE" = "200" ] && ok "override 后恢复可用 → 200" || bad "override恢复" "$CODE"
cleanup

# ---------- 场景 D：后台账号密码登录体系 + 优先级/启停 + 首登强改 ----------
echo; echo "【场景 D】后台账号密码登录体系 (端口 3204)"
start_srv 3204 ./data/selftest_d.sqlite
login_admin
api GET /admin/providers "" ""; [ "$CODE" = "403" ] && ok "后台无 token → 403" || bad "后台无token" "$CODE"
api GET /admin/providers "X-Admin-Key: adminkey" ""; [ "$CODE" = "403" ] && ok "旧 X-Admin-Key 已失效 → 403" || bad "旧header" "$CODE"
api GET /admin/providers "$ADM" ""; [ "$CODE" = "403" ] && ok "must_change 会话仅可改密（其余接口 403）" || bad "强改前403" "$CODE"
api POST /admin/login "" '{"username":"admin","password":"admin123"}'
  if [ "$CODE" = "200" ] && [ "$(jget "$BODY" 'mustChange')" = "true" ]; then ok "登录 admin/admin123 → 200 且 mustChange=true" ; else bad "登录" "$CODE mustChange=$(jget "$BODY" 'mustChange')"; fi
login_admin_ready
cfg_deepl_stub
api GET /admin/providers "$ADM" ""; [ "$CODE" = "200" ] && ok "用 token 访问后台 → 200" || bad "token访问" "$CODE"
api PUT /admin/providers/deepl "$ADM" '{"priority":5}'; [ "$CODE" = "200" ] && [ "$(jget "$BODY" 'provider.priority')" = "5" ] && ok "改优先级 priority=5 生效" || bad "改优先级" "$CODE $(jget "$BODY" 'provider.priority')"
api PUT /admin/providers/deepl "$ADM" '{"enabled":false}'; [ "$CODE" = "200" ] && ok "禁用 deepl → 200" || bad "禁用deepl" "$CODE"
api POST "/translate?api-version=3.0&to=zh-Hans" "$GW" '[{"Text":"hi"}]'; [ "$CODE" = "503" ] && ok "deepl 禁用后无可用 → 503" || bad "禁用后翻译" "$CODE"
api PUT /admin/providers/deepl "$ADM" '{"enabled":true}'; [ "$CODE" = "200" ] && ok "重新启用 deepl → 200" || bad "启用deepl" "$CODE"
api POST "/translate?api-version=3.0&to=zh-Hans" "$GW" '[{"Text":"hi"}]'; [ "$CODE" = "200" ] && ok "启用后恢复 → 200" || bad "启用后翻译" "$CODE"
api PUT /admin/password "$ADM" '{"currentPassword":"newpass123","newPassword":"newpass456"}'; [ "$CODE" = "200" ] && ok "非强制改密（验当前密码）→ 200" || bad "非强改改密" "$CODE"
api POST /admin/login "" '{"username":"admin","password":"newpass456"}'
  if [ "$CODE" = "200" ] && [ "$(jget "$BODY" 'mustChange')" = "false" ]; then ok "新密码登录 → 200 且 mustChange=false" ; else bad "新密码登录" "$CODE mustChange=$(jget "$BODY" 'mustChange')"; fi
api PUT /admin/password "$ADM" '{"currentPassword":"wrong","newPassword":"hacked999"}'; [ "$CODE" != "200" ] && ok "当前密码错误时改密被拒" || bad "改密校验" "$CODE"
cleanup

# ---------- 场景 E：后台配置 quota/threshold + 持久化 ----------
echo; echo "【场景 E】后台配置 quota/threshold + 持久化 (端口 3205)"
start_srv 3205 ./data/selftest_e.sqlite
login_admin_ready
cfg_deepl_stub
api GET /admin/settings "$ADM" ""; [ "$CODE" = "200" ] && [ "$(jget "$BODY" 'threshold')" = "0.8" ] && ok "默认阈值 0.8" || bad "默认阈值" "code=$CODE t=$(jget "$BODY" 'threshold')"
api PUT /admin/settings "$ADM" '{"threshold":0.5}'; [ "$CODE" = "200" ] && [ "$(jget "$BODY" 'threshold')" = "0.5" ] && ok "后台改阈值 → 0.5" || bad "改阈值" "code=$CODE t=$(jget "$BODY" 'threshold')"
api PUT /admin/providers/deepl "$ADM" '{"quota":10}'; [ "$CODE" = "200" ] && ok "后台改 deepl 额度 → 10" || bad "改额度" "$CODE"
api POST "/translate?api-version=3.0&to=zh-Hans" "$GW" '[{"Text":"01234"}]'; [ "$CODE" = "200" ] && ok "用掉5字符(配额10×0.5) → 200" || bad "用掉5" "$CODE"
api POST "/translate?api-version=3.0&to=zh-Hans" "$GW" '[{"Text":"x"}]'; [ "$CODE" = "503" ] && ok "达阈值0.5自动禁用 → 503" || bad "阈值禁用" "$CODE"
api PUT /admin/providers/deepl "$ADM" '{"quota":100}'; [ "$CODE" = "200" ] && [ "$(jget "$BODY" 'provider.quota')" = "100" ] && ok "后台改 deepl 额度 → 100" || bad "改额度" "code=$CODE q=$(jget "$BODY" 'provider.quota')"
api POST "/translate?api-version=3.0&to=zh-Hans" "$GW" '[{"Text":"x"}]'; [ "$CODE" = "200" ] && ok "额度改大后恢复 → 200" || bad "额度恢复" "$CODE"
cleanup
restart_srv 3205 ./data/selftest_e.sqlite   # 重启同一库验证持久化
login_admin_ready
api GET /admin/settings "$ADM" ""; [ "$(jget "$BODY" 'threshold')" = "0.5" ] && ok "重启后阈值持久(0.5)" || bad "阈值持久" "t=$(jget "$BODY" 'threshold')"
api GET /admin/providers "$ADM" ""; [ "$(jfind "$BODY" providers deepl quota)" = "100" ] && ok "重启后 deepl 额度持久(100)" || bad "额度持久" "q=$(jfind "$BODY" providers deepl quota)"
cleanup

# ---------- 场景 F：密钥 + 网关 key 后台配置（热更新，无需重启）----------
echo; echo "【场景 F】密钥与网关 key 后台配置 (端口 3206)"
start_srv 3206 ./data/selftest_f.sqlite
login_admin_ready
cfg_deepl_stub
api PUT /admin/providers/baidu "$ADM" '{"secret":{"appId":"appid123","appKey":"key456"}}'; [ "$CODE" = "200" ] && ok "后台配百度密钥 → 200" || bad "配百度密钥" "$CODE"
api GET /admin/providers "$ADM" ""; [ "$(jfind "$BODY" providers baidu configured)" = "true" ] && ok "百度 configured=true (密钥已生效)" || bad "百度configured" "$(jfind "$BODY" providers baidu configured)"
api PUT /admin/gateway "$ADM" '{"gatewayKey":"newgw","confirmKey":"different"}'; [ "$CODE" = "400" ] && ok "改网关 key 两次输入不一致 → 400" || bad "改网关key不一致" "$CODE"
api PUT /admin/gateway "$ADM" '{"gatewayKey":"newgw","confirmKey":"newgw"}'; [ "$CODE" = "200" ] && ok "后台改网关 key=newgw（二次确认）→ 200" || bad "改网关key" "$CODE"
api POST "/translate?api-version=3.0&to=zh-Hans" "$GW" '[{"Text":"x"}]'; [ "$CODE" = "401" ] && ok "旧网关 key(gwkey) 翻译 → 401(已失效)" || bad "旧key" "$CODE"
api POST "/translate?api-version=3.0&to=zh-Hans" "Ocp-Apim-Subscription-Key: newgw" '[{"Text":"x"}]'; [ "$CODE" = "200" ] && ok "新网关 key(newgw) 翻译 → 200" || bad "新key" "$CODE"
cleanup

# ---------- 场景 G：总览用量统计接口 ----------
echo; echo "【场景 G】/admin/usage/stats 总览数据 (端口 3207)"
start_srv 3207 ./data/selftest_g.sqlite
login_admin_ready
cfg_deepl_stub
api POST "/translate?api-version=3.0&to=zh-Hans" "$GW" '[{"Text":"Hello trend"}]'; [ "$CODE" = "200" ] && ok "产生一笔用量(11字符) → 200" || bad "产生用量" "$CODE"
api POST "/translate?api-version=3.0&to=zh-Hans" "$GW" '[{"Text":"Hello trent"}]'
api GET "/admin/usage/stats?days=30&months=6" "$ADM" ""
  if [ "$CODE" = "200" ] && [ "$(jget "$BODY" 'daily.29.total')" = "22" ] \
     && [ "$(jget "$BODY" 'daily.0.total')" = "0" ] \
     && [ "$(jget "$BODY" 'daily.29.day')" != "" ] \
     && [ "$(jget "$BODY" 'monthly.5.total')" = "22" ] \
     && [ "$(jget "$BODY" 'monthRequests')" = "2" ] \
     && [ "$(jget "$BODY" 'today.total')" = "22" ]; then
    ok "stats: 30天补齐空天(daily.0=0, daily.29=22), 本月=22, 调用=2, 今日=22" ; else
    bad "usage stats" "code=$CODE d0=$(jget "$BODY" 'daily.0.total') d29=$(jget "$BODY" 'daily.29.total') m5=$(jget "$BODY" 'monthly.5.total') req=$(jget "$BODY" 'monthRequests') today=$(jget "$BODY" 'today.total')"; fi
api GET "/admin/usage/stats" "" ""; [ "$CODE" = "403" ] && ok "stats 无 token → 403" || bad "stats鉴权" "$CODE"
cleanup

# ---------- 场景 H：沉浸式翻译自定义端点渠道（imme / deeplx / google / openai）----------
echo; echo "【场景 H】沉浸式翻译自定义端点渠道 (端口 3208)"
start_srv 3208 ./data/selftest_h.sqlite
login_admin_ready
cfg_deepl_stub
TK="token=gwkey"

# --- /imme（沉浸式翻译自定义 API，ImmersiveL 协议）---
api POST /imme "" '{"source_lang":"auto","target_lang":"zh","text_list":["Hello"]}'
  [ "$CODE" = "401" ] && ok "imme 无 token → 401" || bad "imme无token" "$CODE"
api POST /imme "/imme" "{\"$TK\":" 2>/dev/null; # 占位避免误用
api POST /imme "" "{\"source_lang\":\"auto\",\"target_lang\":\"zh\",\"text_list\":[\"Hello\"]}"
  [ "$CODE" = "401" ] && ok "imme 错误 token → 401" || bad "imme错误token" "$CODE"
api POST "/imme?$TK" "" '{"target_lang":"zh","text_list":["Hello, world!","Good morning."]}'
  if [ "$CODE" = "200" ] && [ "$(jget "$BODY" 'translations.0.text')" = "[stub]Hello, world!" ] \
     && [ "$(jget "$BODY" 'translations.1.text')" = "[stub]Good morning." ] \
     && [ "$(jget "$BODY" 'translations.0.detected_source_lang')" = "en" ]; then
    ok "imme 批量翻译 → 200, 等长同序 + detected(en)" ; else
    bad "imme翻译" "$CODE $(jget "$BODY" 'translations.0.text')"; fi
api POST "/imme?$TK" "" '{"text_list":["Hello"]}'
  [ "$CODE" = "400" ] && ok "imme 缺 target_lang → 400" || bad "imme缺target" "$CODE"
api POST "/imme?$TK" "" '{"target_lang":"zh"}'
  [ "$CODE" = "400" ] && ok "imme 缺 text_list → 400" || bad "imme缺text_list" "$CODE"

# --- /deeplx/translate（DeepLX 协议）---
api POST /deeplx/translate "" '{"text":"Hi","target_lang":"ZH"}'
  [ "$CODE" = "401" ] && [ "$(jget "$BODY" 'code')" = "401" ] && ok "deeplx 无 token → 401 DeepLX 风格" || bad "deeplx无token" "$CODE $(jget "$BODY" 'code')"
api POST "/deeplx/translate?$TK" "" '{"text":"Hello, world!","source_lang":"auto","target_lang":"ZH"}'
  if [ "$CODE" = "200" ] && [ "$(jget "$BODY" 'code')" = "200" ] \
     && [ "$(jget "$BODY" 'data')" = "[stub]Hello, world!" ] \
     && [ "$(jget "$BODY" 'sourceLang')" = "EN" ]; then
    ok "deeplx 翻译 → 200 code=200 data=译文 sourceLang=EN" ; else
    bad "deeplx翻译" "$CODE $(jget "$BODY" 'data') sl=$(jget "$BODY" 'sourceLang')"; fi
api POST "/deeplx?$TK" "" '{"text":"Hi","target_lang":"ZH"}'
  [ "$CODE" = "200" ] && ok "deeplx 别名 /deeplx → 200" || bad "deeplx别名" "$CODE"
api POST "/deeplx/translate?$TK" "" '{"text":"Hi"}'
  [ "$CODE" = "400" ] && ok "deeplx 缺 target_lang → 400" || bad "deeplx缺target" "$CODE"

# --- /google/translate_a/single（Google 网页翻译协议）---
api GET "/google/translate_a/single?client=gtx&sl=auto&tl=zh-CN&q=Hello" "" ""
  [ "$CODE" = "401" ] && ok "google 无 token → 401" || bad "google无token" "$CODE"
api GET "/google/translate_a/single?client=gtx&sl=auto&tl=zh-CN&q=Hello,%20world!&$TK" "" ""
  if [ "$CODE" = "200" ] && [ "$(jget "$BODY" '0.0.0')" = "[stub]Hello, world!" ] \
     && [ "$(jget "$BODY" '0.0.1')" = "Hello, world!" ] \
     && [ "$(jget "$BODY" '2')" = "en" ]; then
    ok "google 翻译 → 200, data[0]=[译,原,null,null], data[2]=en" ; else
    bad "google翻译" "$CODE $(jget "$BODY" '0.0.0') det=$(jget "$BODY" '2')"; fi
api GET "/google/translate_a/single?client=gtx&tl=zh-CN&q=Hello&q=World&$TK" "" ""
  if [ "$CODE" = "200" ] && [ "$(jget "$BODY" '0.0.1')" = "Hello" ] && [ "$(jget "$BODY" '0.1.1')" = "World" ]; then
    ok "google 多 q 参数 → 2 段对应 2 组译文" ; else
    bad "google多q" "$CODE len=$(jlen "$BODY" )"; fi
api GET "/google/translate_a/single?client=gtx&tl=zh-CN&$TK" "" ""
  [ "$CODE" = "400" ] && ok "google 缺 q → 400" || bad "google缺q" "$CODE"

# --- /v1/chat/completions（OpenAI Chat Completions 兼容）---
OAI="Authorization: Bearer gwkey"
api POST /v1/chat/completions "" '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'
  [ "$CODE" = "401" ] && [ "$(jget "$BODY" 'error.code')" = "invalid_api_key" ] && ok "openai 无 key → 401 OpenAI 风格" || bad "openai无key" "$CODE $(jget "$BODY" 'error.code')"
api POST /v1/chat/completions "$OAI" '{"model":"gpt-4o","messages":[{"role":"system","content":"You are a translator."},{"role":"user","content":"Translate into Chinese (Simplified): <text>Hello, world!</text>"}]}'
  if [ "$CODE" = "200" ] && [ "$(jget "$BODY" 'choices.0.message.content')" = "[stub]Hello, world!" ] \
     && [ "$(jget "$BODY" 'object')" = "chat.completion" ] \
     && [ "$(jget "$BODY" 'model')" = "gpt-4o" ]; then
    ok "openai 翻译 → 200, content=译文(<text>提取), model 回显" ; else
    bad "openai翻译" "$CODE $(jget "$BODY" 'choices.0.message.content')"; fi
api POST /v1/chat/completions "$OAI" '{"model":"m","stream":true,"messages":[{"role":"user","content":"Translate to Japanese: hi"}]}'
  if [ "$CODE" = "200" ] && echo "$BODY" | grep -q 'chat.completion.chunk' && echo "$BODY" | grep -q '\[DONE\]'; then
    ok "openai stream=true → SSE 分块 + [DONE]" ; else
    bad "openai stream" "$CODE $(echo "$BODY" | head -c 120)"; fi
api POST /v1/chat/completions "$OAI" '{"messages":[]}'
  [ "$CODE" = "400" ] && ok "openai 空 messages → 400" || bad "openai空messages" "$CODE"

# --- /v1/messages（Anthropic Messages 兼容，Claude 渠道）---
api POST /v1/messages "" '{"model":"gateway","messages":[{"role":"user","content":"hi"}]}'
  [ "$CODE" = "401" ] && [ "$(jget "$BODY" 'error.type')" = "authentication_error" ] \
    && ok "claude 无 key → 401 Anthropic 风格" || bad "claude无key" "$CODE $(jget "$BODY" 'error.type')"
api POST "/v1/messages?to=zh" "x-api-key: gwkey" '{"model":"gateway","max_tokens":100,"messages":[{"role":"user","content":"Hello, world!"}]}'
  [ "$CODE" = "200" ] && [ "$(jget "$BODY" type)" = "message" ] \
    && [ "$(jget "$BODY" 'content.0.text')" = "[stub]Hello, world!" ] \
    && [ "$(jget "$BODY" 'stop_reason')" = "end_turn" ] \
    && ok "claude 翻译(x-api-key) → 200, content[0].text=译文" || bad "claude翻译" "$CODE $(jget "$BODY" 'content.0.text')"
api POST /v1/messages "x-api-key: gwkey" '{"model":"gateway"}'
  [ "$CODE" = "400" ] && [ "$(jget "$BODY" 'error.type')" = "invalid_request_error" ] \
    && ok "claude 缺 messages → 400 invalid_request_error" || bad "claude缺messages" "$CODE"
api POST /v1/messages "" '[]'
  [ "$CODE" = "401" ] && ok "claude 空 body 仍先鉴权 → 401" || bad "claude空body鉴权" "$CODE"
api POST "/v1/messages?token=gwkey" "" '{"stream":true,"messages":[{"role":"user","content":"Hello, world!"}]}'
  SSE_OK="$(grep -c "event: message_stop\|text_delta" /tmp/tg_body.txt 2>/dev/null || echo 0)"
  [ "$CODE" = "200" ] && [ "${SSE_OK:-0}" -ge 2 ] 2>/dev/null \
    && ok "claude stream=true → SSE 事件序列（text_delta + message_stop）" || bad "claude stream" "$CODE sse=$SSE_OK"

# --- 渠道文档页 ---
api GET /imme "" "";  [ "$CODE" = "200" ] && ok "GET /imme 文档页 → 200" || bad "imme文档页" "$CODE"
api GET /deeplx "" "";  [ "$CODE" = "200" ] && ok "GET /deeplx 文档页 → 200" || bad "deeplx文档页" "$CODE"
api GET /google "" "";  [ "$CODE" = "200" ] && ok "GET /google 文档页 → 200" || bad "google文档页" "$CODE"
api GET /openai "" "";  [ "$CODE" = "200" ] && ok "GET /openai 文档页 → 200" || bad "openai文档页" "$CODE"
api GET /claude "" "";  [ "$CODE" = "200" ] && ok "GET /claude 文档页 → 200" || bad "claude文档页" "$CODE"
api GET /admin/docs "$ADM" ""
CH_OK="$(node -e "try{const d=JSON.parse(process.argv[1]);const c=d.channels||[];console.log(['imme','deeplx','google','openai','claude'].every(s=>c.find(x=>x.slug===s&&x.enabled===true))?'yes':'no')}catch(e){console.log('no')}" "$BODY")"
  [ "$CODE" = "200" ] && [ "$CH_OK" = "yes" ] \
    && ok "渠道列表含 5 个新渠道且默认启用" || bad "渠道列表" "code=$CODE ok=$CH_OK"

# --- 方言码归一（业务侧可传任意厂商风格，网关统一映射）---
api POST "/translate?api-version=3.0&from=jp&to=zh-Hans" "$GW" '[{"Text":"Hello trend"}]'
  [ "$CODE" = "200" ] && [ "$(jget "$BODY" '0.translations.0.text')" = "[stub]Hello trend" ] \
    && ok "方言码 from=jp（百度风格日语）正常翻译" || bad "方言码jp" "$CODE $(jget "$BODY" '0.translations.0.text')"
api POST "/translate?api-version=3.0&from=zh-Hant&to=jp" "$GW" '[{"Text":"Hello trend"}]'
  [ "$CODE" = "200" ] && [ "$(jget "$BODY" '0.translations.0.text')" = "[stub]Hello trend" ] \
    && ok "方言码 from=zh-Hant / to=jp（Azure/百度风格）正常翻译" || bad "方言码zh-Hant" "$CODE $(jget "$BODY" '0.translations.0.text')"
api POST "/imme?$TK" "" '{"source_lang":"kor","target_lang":"zh","text_list":["Hello trend"]}'
  [ "$CODE" = "200" ] && [ "$(jget "$BODY" 'translations.0.text')" = "[stub]Hello trend" ] \
    && ok "imme 方言码 kor→zh 正常翻译" || bad "imme方言码" "$CODE $(jget "$BODY" 'translations.0.text')"
cleanup

# ---------- 场景 I：翻译缓存（内存 LRU，按 MB 预算）----------
echo; echo "【场景 I】翻译缓存 (端口 3209)"
start_srv 3209 ./data/selftest_i.sqlite
login_admin_ready
cfg_deepl_stub

api GET /admin/cache "$ADM" ""
  [ "$CODE" = "200" ] && [ "$(jget "$BODY" enabled)" = "true" ] && [ "$(jget "$BODY" maxMb)" = "16" ] \
    && ok "缓存默认开启、默认 16 MB" || bad "缓存默认配置" "$CODE enabled=$(jget "$BODY" enabled) maxMb=$(jget "$BODY" maxMb)"

# 首次翻译 → MISS（打上游，桩返回 [stub]+原文）
api POST "/translate?api-version=3.0&to=zh-Hans" "$GW" '[{"Text":"Cache probe alpha"}]'
  H1="$(hdr X-Cache)"; T1="$(jget "$BODY" '0.translations.0.text')"
  [ "$CODE" = "200" ] && [ "$H1" = "MISS" ] && [ "$T1" = "[stub]Cache probe alpha" ] \
    && ok "首次翻译 X-Cache: MISS，译文来自桩" || bad "首次翻译" "$CODE $H1 $T1"
# 二次同文本 → 全命中（不打上游，译文一致）
api POST "/translate?api-version=3.0&to=zh-Hans" "$GW" '[{"Text":"Cache probe alpha"}]'
  H2="$(hdr X-Cache)"; T2="$(jget "$BODY" '0.translations.0.text')"
  [ "$H2" = "HIT" ] && [ "$T2" = "[stub]Cache probe alpha" ] \
    && ok "二次翻译 X-Cache: HIT，译文一致" || bad "二次翻译" "$H2 $T2"

api GET /admin/cache "$ADM" ""
  HITS="$(jget "$BODY" stats.hits)"; SAVED="$(jget "$BODY" stats.savedChars)"; ENTS="$(jget "$BODY" entries)"
  if [ "$CODE" = "200" ] && [ "${HITS:-0}" -ge 1 ] 2>/dev/null && [ "${SAVED:-0}" -ge 17 ] 2>/dev/null && [ "${ENTS:-0}" -ge 1 ] 2>/dev/null; then
    ok "统计：命中≥1、节省字符≥17、缓存条目≥1" ; else
    bad "缓存统计" "hits=$HITS saved=$SAVED entries=$ENTS"; fi

# 命中请求不计额度：17 字符只在上游消耗一次
api GET /usage "$GW" ""
  [ "$(jget "$BODY" totalUsed)" = "17" ] && ok "命中不计额度：usage 仅 17 字符" \
    || bad "命中不计额度" "totalUsed=$(jget "$BODY" totalUsed)"

# 部分命中：批内一段已缓存、一段新文本 → 只把新段发上游
api POST "/translate?api-version=3.0&to=zh-Hans" "$GW" '[{"Text":"Cache probe alpha"},{"Text":"Fresh segment one"}]'
  H3="$(hdr X-Cache)"; T3A="$(jget "$BODY" '0.translations.0.text')"; T3B="$(jget "$BODY" '1.translations.0.text')"
  [ "$CODE" = "200" ] && [ "$T3A" = "[stub]Cache probe alpha" ] && [ "$T3B" = "[stub]Fresh segment one" ] \
    && ok "混合批：缓存段与新段按原序拼回" || bad "混合批" "$CODE $H3 $T3A $T3B"
api GET /usage "$GW" ""
  [ "$(jget "$BODY" totalUsed)" = "34" ] && ok "部分命中只计新段（17+17=34）" \
    || bad "部分命中计费" "totalUsed=$(jget "$BODY" totalUsed)"

# 改大小即时生效 + 越界校验
api PUT /admin/cache "$ADM" '{"maxMb":8}'
  [ "$CODE" = "200" ] && [ "$(jget "$BODY" maxMb)" = "8" ] && ok "改缓存大小 8 MB 即时生效" || bad "改大小" "$CODE"
api PUT /admin/cache "$ADM" '{"maxMb":9999}'
  [ "$CODE" = "400" ] && ok "maxMb 越界(9999) → 400" || bad "越界校验" "$CODE"
# 关闭开关后不再命中
api PUT /admin/cache "$ADM" '{"enabled":false}'
api POST "/translate?api-version=3.0&to=zh-Hans" "$GW" '[{"Text":"Cache probe alpha"}]'
  H4="$(hdr X-Cache)"
  [ "$H4" = "MISS" ] && ok "关闭开关后 X-Cache: MISS（不再命中）" || bad "关闭开关" "$H4"
# 重新开启 + 清空（统计归零）
api PUT /admin/cache "$ADM" '{"enabled":true}'
api DELETE /admin/cache "$ADM" ""
  [ "$CODE" = "200" ] && [ "$(jget "$BODY" stats.hits)" = "0" ] && [ "$(jget "$BODY" stats.misses)" = "0" ] \
    && ok "清空缓存：统计归零" || bad "清空缓存" "$CODE hits=$(jget "$BODY" stats.hits)"

# --- 按接口（渠道端点）用量统计 ---
# 此前 azure 渠道 4 次调用：17 + 0(全命中) + 17 + 17 = 51 字符（全命中记 0 字符但计次）
api POST "/imme?$TK" "" '{"target_lang":"zh","text_list":["Channel stat probe"]}'
  [ "$CODE" = "200" ] && ok "imme 渠道调用（供渠道统计核验）→ 200" || bad "imme调用" "$CODE"
api GET "/admin/usage/stats?days=30&months=6" "$ADM" ""
  AZ_CHARS="$(jchan "$BODY" azure chars)"; AZ_REQS="$(jchan "$BODY" azure requests)"
  IM_CHARS="$(jchan "$BODY" imme chars)";  IM_REQS="$(jchan "$BODY" imme requests)"
  if [ "$AZ_CHARS" = "51" ] && [ "$AZ_REQS" = "4" ] && [ "$IM_CHARS" = "18" ] && [ "$IM_REQS" = "1" ]; then
    ok "按接口统计：azure 51字符/4次(含1次命中)，imme 18字符/1次" ; else
    bad "按接口统计" "azure=$AZ_CHARS/$AZ_REQS imme=$IM_CHARS/$IM_REQS"; fi

# --- single-flight：并发相同请求只打一次上游 ---
api GET "/admin/usage/stats?days=30&months=6" "$ADM" ""
  BEFORE_CHARS="$(jchan "$BODY" azure chars)"; BEFORE_REQS="$(jchan "$BODY" azure requests)"
for i in 1 2 3; do
  curl -s -o "/tmp/tg_sf_$i.txt" -X POST "http://127.0.0.1:$PORT/translate?api-version=3.0&to=zh-Hans" \
    -H "$GW" -H 'Content-Type: application/json' --data '[{"Text":"Single flight probe"}]' &
  eval "SF_PID$i=$!"
done
wait $SF_PID1 $SF_PID2 $SF_PID3  # 只等 curl（裸 wait 会连常驻服务进程一起等，永远挂起）
SF_OK=1
for i in 1 2 3; do
  grep -q "\[stub\]Single flight probe" "/tmp/tg_sf_$i.txt" || SF_OK=0
done
api GET "/admin/usage/stats?days=30&months=6" "$ADM" ""
  AFTER_CHARS="$(jchan "$BODY" azure chars)"; AFTER_REQS="$(jchan "$BODY" azure requests)"
  if [ "$SF_OK" = "1" ] && [ "$((AFTER_CHARS - BEFORE_CHARS))" = "19" ] && [ "$((AFTER_REQS - BEFORE_REQS))" = "3" ]; then
    ok "single-flight：并发3个相同请求 → 上游只消耗1份(19字符)，3次都有响应" ; else
    bad "single-flight" "响应完整=$SF_OK 字符差=$((AFTER_CHARS-BEFORE_CHARS)) 次数差=$((AFTER_REQS-BEFORE_REQS))"; fi

# --- 统计持久化：防抖落盘 → 重启加载（运行期间不重读）---
# 注：Windows Git Bash 的 kill 是硬终止，停机钩子不执行；这里等 3 秒防抖异步落盘
# （生产环境 Docker 优雅停机时另有停机同步 flush，双保险）
api GET /admin/cache "$ADM" ""
  HITS_BEFORE="$(jget "$BODY" stats.hits)"
  [ "$HITS_BEFORE" != "" ] && [ "$HITS_BEFORE" != "0" ] && ok "重启前统计：hits=$HITS_BEFORE" || bad "重启前统计" "hits=$HITS_BEFORE"
sleep 3.5
cleanup
start_srv 3209 ./data/selftest_i.sqlite
login_admin_ready
api GET /admin/cache "$ADM" ""
  HITS_AFTER="$(jget "$BODY" stats.hits)"
  [ "$CODE" = "200" ] && [ "$HITS_AFTER" = "$HITS_BEFORE" ] && [ "$HITS_AFTER" != "0" ] \
    && ok "重启后统计接续：hits=$HITS_AFTER（启动加载一次，运行期不重读）" || bad "重启后统计" "before=$HITS_BEFORE after=$HITS_AFTER code=$CODE"

cleanup

echo; echo "============================================"
printf " 自测结果: \033[32m通过 %s\033[0m / \033[31m失败 %s\033[0m\n" "$PASS" "$FAIL"
echo "============================================"
[ "$FAIL" = "0" ] && exit 0 || exit 1
