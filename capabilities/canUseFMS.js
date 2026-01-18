module.exports = function canUseFMS(caps) {
  return !!caps?.fms_enabled;
};
