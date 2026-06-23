const defaultTarget = 'http://localhost:3000';
const rawTarget = process.env.SFU_BACKEND_ORIGIN?.trim();
const target = normalizeTarget(rawTarget && rawTarget.length > 0 ? rawTarget : defaultTarget);

module.exports = {
  '/api': {
    target,
    changeOrigin: true,
    secure: false
  }
};

function normalizeTarget(value) {
  try {
    return new URL(value).origin;
  } catch (error) {
    throw new Error(`Invalid SFU_BACKEND_ORIGIN "${value}". Use a full origin such as http://localhost:3000.`, { cause: error });
  }
}
