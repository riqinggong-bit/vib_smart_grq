from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
from reportlab.lib import colors

OUT='/Users/mmiao/Desktop/液体智能网页/液态智能网页功能说明.pdf'
pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
styles=getSampleStyleSheet(); font='STSong-Light'
title=ParagraphStyle('t',parent=styles['Title'],fontName=font,fontSize=24,textColor=colors.HexColor('#11111E'),spaceAfter=8)
sub=ParagraphStyle('s',parent=styles['Normal'],fontName=font,fontSize=11,textColor=colors.HexColor('#E35D45'),alignment=TA_CENTER,spaceAfter=16)
h1=ParagraphStyle('h1',parent=styles['Heading1'],fontName=font,fontSize=17,textColor=colors.HexColor('#11111E'),spaceBefore=12,spaceAfter=6)
h2=ParagraphStyle('h2',parent=styles['Heading2'],fontName=font,fontSize=12,textColor=colors.HexColor('#E35D45'),spaceBefore=8,spaceAfter=3)
body=ParagraphStyle('b',parent=styles['BodyText'],fontName=font,fontSize=10.5,leading=17,textColor=colors.HexColor('#2D2D37'))
small=ParagraphStyle('sm',parent=body,fontSize=9,leading=13)
def P(x,st=body): return Paragraph(x,st)
story=[P('液态智能网页功能说明',title),P('产品功能、交互流程、部署状态与后续边界',sub),P('文档版本 1.0　·　2026年9月',sub)]
story += [P('文档概述',h1),P('液态智能网页是一套“从自然语言需求到可操作网页”的生成系统。用户只需输入一次完整 Query，系统会先理解目标、约束和事实，再生成一份统一的任务答案，并以七种不同的网页形态呈现。它适用于商品推荐、方案比较、学习规划、旅行安排、项目管理、预算计算和数据分析等任务。'),P('当前版本已经完成可公开演示的核心闭环，并部署在 Render。它更适合作为产品原型和邀请制试用版本；涉及价格、库存或专业结论的内容，仍应在行动前再次核实。')]
story += [P('核心功能',h1)]
for h,t in [('统一 Query 输入','支持输入目标、预算、偏好、已有资料和限制条件，最大长度为 6000 字符。'),('需求与约束理解','自动提取用户目标、硬性条件、用户提供信息、待核实事实、假设和预期交付结果。'),('统一答案与七种形态','同一份事实、比较结果和最终结论会被复用到七种网页形态。'),('任务型内容生成','根据任务选择步骤、卡片、表格、时间线、对比、计算器、图表和清单等组件。'),('品牌与选购入口','购买类需求至少列出三个候选项，并提供京东、淘宝或官网搜索入口。'),('事实状态展示','内容可以标记为用户提供、已验证或待核实，减少事实冲突。'),('可操作交互','支持比较表、计算器滑块、清单勾选、模块导航和形态切换。'),('状态恢复','浏览器保存 Query、已生成页面、计算器数值和清单状态；服务端会话有效期为两小时。'),('错误与服务保护','支持超时提示、临时拥堵自动重试、API Key 检查、健康检查、限流和安全响应头。')]: story += [P(h,h2),P(t)]
story += [P('用户使用流程',h1)]
data=[[P(x,small) for x in ['阶段','用户操作','系统结果']]]
for row in [('1 输入','填写完整 Query 并提交','理解目标、提取约束和整理共享事实'),('2 选择','浏览七张网页形态卡片','七种形态共享同一份答案'),('3 展开','点击任意卡片','显示生成进度并进入完整任务页面'),('4 操作','查看证据、比较候选、调节参数或勾选清单','页面状态即时更新并保存'),('5 跳转','点击品牌或平台入口','在新标签页打开站内搜索页面')]: data.append([P(x,small) for x in row])
t=Table(data,colWidths=[55,190,255]); t.setStyle(TableStyle([('GRID',(0,0),(-1,-1),.5,colors.HexColor('#999999')),('BACKGROUND',(0,0),(-1,0),colors.HexColor('#20203A')),('TEXTCOLOR',(0,0),(-1,0),colors.white),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),6),('RIGHTPADDING',(0,0),(-1,-1),6)])); story += [t]
story += [P('页面形态',h1),P('手账决策本、双区分析台、专题编辑部、ICE 速览报、留白阅读页、任务工作台和数据驾驶舱，分别覆盖生活决策、参数分析、专题阅读、快速浏览、解释学习、项目执行和数据监控。')]
story += [P('部署与访问',h1),P('当前网站已经部署到 Render，可通过以下地址访问：'),P('<font color="#235FB4"><u>https://liquid-intelligent-web.onrender.com</u></font>'),P('服务器端通过环境变量保存 Gemini API Key，前端不会直接暴露密钥。服务监听平台提供的 PORT，并支持 HTTPS。Render 免费实例长时间无访问后会休眠，首次访问可能需要等待约一分钟。')]
story += [P('当前限制',h1)]
for x in ['服务器会话和限流记录保存在进程内存中，重启或休眠后可能丢失。','公开访问会消耗站长配置的 Gemini API 配额。','品牌入口目前是京东、淘宝和官网搜索链接，不等同于实时商品详情页。','价格、库存、尺寸和性能等外部信息若未接入实时数据源，会标为待核实。','当前适合演示和小规模试用，尚未包含用户登录、多用户历史记录和数据库持久化。']: story += [P('• '+x)]
story += [P('后续建议',h1)]
for i,x in enumerate(['接入实时搜索或电商数据源。','增加自动重连和统一错误提示。','加入访问密码、用户级配额和用量监控。','将会话和生成页面迁移到数据库或 Redis。','建立跨领域评测，持续检查理解、事实、计算和适配度。'],1): story += [P(f'{i}. {x}')]
doc=SimpleDocTemplate(OUT,pagesize=A4,rightMargin=50,leftMargin=50,topMargin=45,bottomMargin=45); doc.build(story); print(OUT)
