const defaultTarget = 'http://localhost:3000';
const rawTarget = process.env.SFU_BACKEND_ORIGIN?.trim();
const target = normalizeTarget(rawTarget && rawTarget.length > 0 ? rawTarget : defaultTarget);

module.exports = {
  '/api': {
    target,
    changeOrigin: true,
    secure: false
  },
  '/socket.io': {
    target,
    changeOrigin: true,
    secure: false,
    ws: true
  }
};

function normalizeTarget(value) {
  try {
    return new URL(value).origin;
  } catch (error) {
    throw new Error(
      `Invalid SFU_BACKEND_ORIGIN "${value}". Use a full origin such as http://localhost:3100.`,
      { cause: error }
    );
  }
}
