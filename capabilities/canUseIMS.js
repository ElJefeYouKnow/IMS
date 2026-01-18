module.exports = function canUseIMS(caps) {
  return !!caps?.ims_enabled;
};
