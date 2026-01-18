module.exports = function canUseAutomation(caps) {
  return !!caps?.ims_enabled && !!caps?.automation_enabled;
};
