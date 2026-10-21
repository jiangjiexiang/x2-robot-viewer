import { ModelLoaderFactory } from '../loaders/ModelLoaderFactory.js';
import { mappedPose, validateFrame } from './JointTelemetry.js';
import './live-joints.css';

export class LiveJointPanel {
    constructor(app) {
        this.app = app;
        this.arm = 'left';
        this.frame = null;
        this.source = null;
        this.paused = false;
        this.connected = false;
        this.lastFrameAt = 0;
        this.lastApplied = '';
        this.modelSequences = {};
        this.fault = '';
        this.histories = { left: [], right: [] };
        this.lockedControls = new Map();
        this.createUI();
        this.app.poseController.subscribe(event => {
            if (event.type === 'modelChanged') {
                this.lastApplied = '';
                this.modelSequences = {};
                this.refresh();
            }
        });
        this.timer = setInterval(() => this.refresh(), 200);
        window.addEventListener('pagehide', () => {
            this.disconnect();
            clearInterval(this.timer);
        }, { once: true });
    }

    createUI() {
        document.body.classList.add('joint-viewer');
        this.element = document.createElement('aside');
        this.element.id = 'live-joint-panel';
        this.element.setAttribute('aria-label', '机械臂话题数据');
        this.element.innerHTML = `
            <header class="live-header">
                <div><span class="live-eyebrow">ROS · JOINT TELEMETRY</span><h1>机械臂实时姿态</h1></div>
                <span class="live-readonly" data-field="source">只读</span>
            </header>
            <div class="live-content">
                <div class="live-status" data-state="waiting" role="status" aria-live="polite">
                    <span class="live-dot"></span><strong data-field="status">正在加载模型</strong>
                </div>
                <p class="live-message" data-field="message">加载 x2 整机与话题配置…</p>
                <div class="live-source-select" role="group" aria-label="选择显示的机械臂">
                    <button type="button" data-arm="left" aria-pressed="true">左臂</button>
                    <button type="button" data-arm="right" aria-pressed="false">右臂</button>
                </div>
                <div class="live-topic"><span>数据话题</span><code data-field="topic">—</code></div>
                <div class="live-metrics">
                    <div><span>接收频率</span><strong data-field="rate">—</strong></div>
                    <div><span>最近一帧</span><strong data-field="age">—</strong></div>
                </div>
                <div class="live-table-heading"><strong>关节角度</strong><span data-field="model">x2 整机</span></div>
                <table class="live-joints-table">
                    <thead><tr><th>关节</th><th>弧度 rad</th><th>角度 °</th></tr></thead>
                    <tbody></tbody>
                </table>
                <div class="live-gripper"><span>第 7 路 · 夹爪原始值</span><output data-field="gripper">—</output></div>
                <p class="live-footnote">上表显示话题的前六路关节角，第七路夹爪单独显示。</p>
                <div class="live-actions">
                    <button type="button" data-action="connect" class="live-primary">连接数据</button>
                    <button type="button" data-action="pause" disabled>暂停显示</button>
                </div>
                <button type="button" data-action="model" class="live-model-button">重新加载 x2 整机</button>
                <details class="live-mapping"><summary>关节映射</summary><pre data-field="mapping"></pre></details>
                <p class="live-error" data-field="error" role="alert"></p>
            </div>`;
        document.getElementById('container').append(this.element);
        this.fields = Object.fromEntries([...this.element.querySelectorAll('[data-field]')].map(el => [el.dataset.field, el]));
        this.connectButton = this.element.querySelector('[data-action="connect"]');
        this.pauseButton = this.element.querySelector('[data-action="pause"]');
        this.connectButton.addEventListener('click', () => this.source ? this.disconnect() : this.connect());
        this.pauseButton.addEventListener('click', () => {
            this.paused = !this.paused;
            this.pauseButton.textContent = this.paused ? '继续显示' : '暂停显示';
            this.lastApplied = '';
            this.refresh();
        });
        this.element.querySelector('[data-action="model"]').addEventListener('click', async event => {
            event.target.disabled = true;
            try { await this.loadModel(); this.fault = ''; }
            catch (error) { this.fault = error.message; }
            finally { event.target.disabled = false; this.refresh(); }
        });
        for (const button of this.element.querySelectorAll('[data-arm]')) {
            button.addEventListener('click', () => {
                this.arm = button.dataset.arm;
                this.paused = false;
                this.pauseButton.textContent = '暂停显示';
                for (const item of this.element.querySelectorAll('[data-arm]')) {
                    item.setAttribute('aria-pressed', String(item === button));
                }
                this.lastApplied = '';
                this.clearNumbers();
                this.refresh();
            });
        }
        // The original viewer panels remain available from its toolbar.
        for (const entry of this.app.mobileLayout.entries) this.app.mobileLayout.setVisible(entry, false);
    }

    async init() {
        try {
            const response = await fetch('/api/config', { cache: 'no-store' });
            if (!response.ok) throw new Error('请先启动本地数据服务');
            this.config = await response.json();
            if (!['rad', 'deg'].includes(this.config.input_unit) || this.config.joint_names?.length !== 6 ||
                this.config.signs?.length !== 6 || this.config.offsets_rad?.length !== 6) {
                throw new Error('关节映射配置无效');
            }
            this.fields.model.textContent = this.config.model_label || this.config.model;
            this.rows = this.config.joint_names.map((name, index) => {
                const row = document.createElement('tr');
                const label = document.createElement('th');
                label.scope = 'row';
                label.textContent = name;
                const rad = document.createElement('td');
                const deg = document.createElement('td');
                rad.textContent = deg.textContent = '—';
                row.append(label, rad, deg);
                this.element.querySelector('tbody').append(row);
                return { name, rad, deg, index };
            });
            this.fields.mapping.textContent = this.config.joint_names.map((name, i) => {
                const left = this.config.model_joint_names?.left?.[i] || name;
                const right = this.config.model_joint_names?.right?.[i] || name;
                return `joint_pos[${i}] → ${left} / ${right}\n  × ${this.config.signs[i]} + ${this.config.offsets_rad[i]} rad`;
            }).join('\n') + `\n输入单位：${this.config.input_unit}\n第 7 路不映射到旋转关节`;
            await this.loadModel();
            this.connect();
        } catch (error) {
            this.fault = error.message;
            this.setStatus('error', '初始化失败', error.message);
        }
    }

    async loadModel() {
        if (!this.config) throw new Error('数据配置尚未加载，请启动服务后刷新网页');
        const base = this.config.model.substring(0, this.config.model.lastIndexOf('/') + 1);
        const paths = [this.config.model, ...this.config.meshes.map(name => `${base}meshes/${name}`)];
        const entries = await Promise.all(paths.map(async path => {
            const response = await fetch(`/${path}`);
            if (!response.ok) throw new Error(`模型资源加载失败：${path}`);
            const file = new File([await response.blob()], path.split('/').pop());
            return [path, file];
        }));
        const fileMap = new Map(entries);
        const file = fileMap.get(this.config.model);
        const model = await ModelLoaderFactory.loadModel('urdf', await file.text(), this.config.model, fileMap, file);
        this.app.fileHandler.fileMap = fileMap;
        this.app.fileHandler.currentModelFile = file;
        const files = [{ file, name: file.name, path: this.config.model, type: 'urdf', category: 'model', ext: 'urdf' }];
        this.app.fileHandler.availableModels = files;
        this.app.fileTreeView.updateFileTree(files, fileMap);
        await this.app.handleModelLoaded(model, file);
        const editorEntry = this.app.mobileLayout.entries.find(({ panel }) => panel.id === 'code-editor-panel');
        if (editorEntry) this.app.mobileLayout.setVisible(editorEntry, false);
        this.lastApplied = '';
        this.modelSequences = {};
        this.refresh();
    }

    connect() {
        if (!this.config || this.source) return;
        this.frame = null;
        this.modelSequences = {};
        this.paused = false;
        this.pauseButton.textContent = '暂停显示';
        this.lastApplied = '';
        this.histories = { left: [], right: [] };
        this.clearNumbers();
        this.fault = '';
        this.source = new EventSource('/api/joints');
        this.connectButton.textContent = '断开数据';
        this.pauseButton.disabled = false;
        this.setStatus('waiting', '正在连接', '等待数据服务返回关节状态…');
        this.source.onopen = () => { this.connected = true; this.refresh(); };
        this.source.onmessage = event => {
            try {
                const frame = validateFrame(JSON.parse(event.data));
                this.frame = frame;
                this.lastFrameAt = performance.now();
                this.fault = frame.error || '';
                for (const arm of ['left', 'right']) {
                    const sample = frame.arms[arm];
                    if (!sample) continue;
                    const history = this.histories[arm];
                    history.push({ time: frame.server_time, sequence: sample.sequence });
                    while (history.length > 2 && history[0].time < frame.server_time - 2) history.shift();
                }
                this.refresh();
            } catch (error) {
                this.fault = error.message;
                this.refresh();
            }
        };
        this.source.onerror = () => {
            this.connected = false;
            this.refresh();
        };
    }

    disconnect() {
        this.source?.close();
        this.source = null;
        this.connected = false;
        this.connectButton.textContent = '连接数据';
        this.pauseButton.disabled = true;
        this.refresh();
    }

    clearNumbers() {
        for (const row of this.rows || []) row.rad.textContent = row.deg.textContent = '—';
        this.fields.gripper.textContent = '—';
        this.fields.rate.textContent = this.fields.age.textContent = '—';
    }

    setStatus(state, title, message) {
        this.element.querySelector('.live-status').dataset.state = state;
        if (this.fields.status.textContent !== title) this.fields.status.textContent = title;
        if (this.fields.message.textContent !== message) this.fields.message.textContent = message;
    }

    lockControls(active) {
        if (active) {
            const controls = document.querySelectorAll('#joint-controls input, #joint-controls button, #reset-joints-btn, #toggle-animation-panel');
            for (const control of controls) {
                if (!this.lockedControls.has(control)) this.lockedControls.set(control, control.disabled);
                control.disabled = true;
            }
        } else {
            for (const [control, wasDisabled] of this.lockedControls) control.disabled = wasDisabled;
            this.lockedControls.clear();
        }
    }

    refresh() {
        if (!this.config) return;
        const name = this.arm === 'left' ? '左臂' : '右臂';
        this.fields.topic.textContent = this.config.topics[this.arm];
        const sample = this.frame?.arms[this.arm];
        const streamAge = (performance.now() - this.lastFrameAt) / 1000;
        const age = sample ? Math.max(0, this.frame.server_time - sample.received_at) + streamAge : Infinity;
        const stale = age > this.config.stale_after_seconds;
        const bindings = this.config.model_joint_names?.[this.arm] || this.config.joint_names;
        const missing = bindings.filter(joint => !this.app.poseController.model?.joints.has(joint));
        const error = this.fault || (missing.length ? this.config.binding_note || `当前模型缺少关节：${missing.join(', ')}。` : this.config.model_notice || '');
        if (this.fields.error.textContent !== error) this.fields.error.textContent = error;
        const live = Boolean(this.source);
        document.body.classList.toggle('ros-stream-active', live);
        this.lockControls(live);
        if (this.app.sceneManager.dragControls) this.app.sceneManager.dragControls.enabled = !live;
        this.element.dataset.mode = this.frame?.mode || '';
        this.fields.source.textContent = this.frame?.mode === 'demo' ? '演示 · 只读' : this.frame?.mode === 'ros' ? 'ROS1 · 只读' : '只读';
        if (!live) {
            this.setStatus('waiting', '已断开', '保留最后显示的姿态，点击连接可继续接收。');
        } else if (!this.connected) {
            this.setStatus('error', '数据服务未连接', '请确认数据服务已启动，网页正在自动重连。');
        } else if (this.fault) {
            this.setStatus('error', '数据异常', '已保留最后一帧有效姿态。');
        } else if (!sample) {
            this.setStatus('waiting', '等待' + name + '话题', '服务已连接，尚未收到所选机械臂的关节消息。');
        } else if (stale) {
            this.setStatus('error', '话题数据已过期', '模型停留在最后一帧，请检查话题是否仍在发布。');
        } else if (this.paused) {
            this.setStatus('waiting', '显示已暂停', '继续接收数据，点击“继续显示”更新模型。');
        } else if (this.frame.mode === 'demo') {
            this.setStatus('demo', '本地演示 · 非实机', missing.length ? '合成角度数据；x2 URDF 未定义机械臂关节，整机模型保持静态。' : '当前为合成关节数据，用于验证网页显示。');
        } else if (missing.length) {
            this.setStatus('waiting', name + '实时角度 · 模型未绑定', '已读取真实角度；x2 整机的机械臂暂为静态显示。');
        } else {
            this.setStatus('live', '双臂关节已绑定 · ' + name, this.config.model_notice ? '两臂按真实关节角更新；安装关系待实机校验。' : '模型根据话题关节角更新。');
        }
        if (sample) {
            this.fields.age.textContent = age < 10 ? `${age.toFixed(1)} s` : `${Math.round(age)} s`;
            const h = this.histories[this.arm];
            const first = h[0], last = h[h.length - 1];
            const hz = first && last && last.time - first.time > 0.2 ?
                (last.sequence - first.sequence) / (last.time - first.time) : null;
            this.fields.rate.textContent = this.connected && !stale && hz !== null ? `${Math.max(0, hz).toFixed(0)} Hz` : '—';
        }
        if (live && this.connected && !this.paused && !this.fault && this.frame) this.applyModelPoses();
        if (!sample || !live || !this.connected || stale || this.paused || this.fault) return;
        const key = `${this.arm}:${sample.sequence}`;
        if (key === this.lastApplied) return;
        const pose = mappedPose(sample, this.config);
        for (const row of this.rows) {
            const angle = pose[row.name];
            row.rad.textContent = angle.toFixed(4);
            row.deg.textContent = (angle * 180 / Math.PI).toFixed(2);
        }
        this.fields.gripper.textContent = Number.isFinite(sample.positions[6]) ? sample.positions[6].toFixed(4) : '—';
        this.lastApplied = key;
    }

    applyModelPoses() {
        const model = this.app.poseController.model;
        if (!model) return;
        let changed = false;
        for (const arm of ['left', 'right']) {
            const sample = this.frame.arms[arm];
            if (!sample || this.modelSequences[arm] === sample.sequence) continue;
            const age = this.frame.server_time - sample.received_at + (performance.now() - this.lastFrameAt) / 1000;
            if (age > this.config.stale_after_seconds) continue;
            const names = this.config.model_joint_names?.[arm] || this.config.joint_names;
            if (names.some(name => !model.joints.has(name) || model.joints.get(name).type === 'fixed')) continue;
            const values = Object.values(mappedPose(sample, this.config));
            if (this.app.animationWorkspace?.playback.playing) this.app.animationWorkspace.playback.pause();
            names.forEach((name, i) => this.app.poseController.setJointValue(name, values[i], {
                source: 'rosTelemetry', commit: false, ignoreLimits: true,
                applyConstraints: false, render: false, measure: false
            }));
            this.modelSequences[arm] = sample.sequence;
            changed = true;
        }
        if (changed) {
            this.app.sceneManager.redraw();
            this.app.sceneManager.onMeasurementUpdate?.();
        }
    }
}
