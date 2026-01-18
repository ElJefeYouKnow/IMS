module.exports = function canUseIntegration(caps) {
  return !!caps?.integration_enabled;
};
