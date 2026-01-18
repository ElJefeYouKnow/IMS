module.exports = function canUseOMS(caps) {
  return !!caps?.oms_enabled;
};
