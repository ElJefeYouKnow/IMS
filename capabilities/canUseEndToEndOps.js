module.exports = function canUseEndToEndOps(caps) {
  return !!caps?.end_to_end_ops;
};
