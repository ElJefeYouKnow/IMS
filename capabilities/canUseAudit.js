module.exports = function canUseAudit(caps) {
  return !!caps?.ims_enabled && !!caps?.audit_enabled;
};
