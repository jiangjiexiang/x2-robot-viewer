// Shared conversion path for table values and model transforms.
export function mappedPose(sample, config) {
    const positions = sample?.positions;
    if (!Array.isArray(positions) || positions.length < 6 || !positions.every(Number.isFinite)) {
        throw new Error('关节消息必须包含至少 6 个有效数值');
    }
    const scale = config.input_unit === 'deg' ? Math.PI / 180 : 1;
    return Object.fromEntries(config.joint_names.map((name, index) => [
        name, positions[index] * scale * config.signs[index] + config.offsets_rad[index]
    ]));
}

export function validateFrame(frame) {
    if (!frame || !['ros', 'demo'].includes(frame.mode) || !Number.isFinite(frame.server_time) ||
        !frame.arms || typeof frame.arms !== 'object') {
        throw new Error('数据接口返回了无效消息');
    }
    for (const arm of ['left', 'right']) {
        const sample = frame.arms[arm];
        if (!sample) continue;
        if (!Number.isFinite(sample.received_at) || !Number.isSafeInteger(sample.sequence) ||
            !Array.isArray(sample.positions) || sample.positions.length < 6 ||
            !sample.positions.every(Number.isFinite)) {
            throw new Error('关节数据格式错误，已保留上一帧姿态');
        }
    }
    return frame;
}
